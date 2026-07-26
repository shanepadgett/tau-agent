use crate::{
    language::OdinLanguage,
    markdown::{extract_markdown_items, validate_markdown_source},
    outline::{
        LanguageId, ParseCertainty, RecursiveBudgets, SourceRange, encode_search_match_locator,
        encode_search_scope_locator, language_for_path, relative_path, source_fingerprint,
        validate_recursive_budgets,
    },
    source::{certainty, certainty_reason, source_range},
};
use ast_grep_core::{Doc, Matcher, Node, Pattern, tree_sitter::LanguageExt};
use ast_grep_language::SupportLang;
use ignore::WalkBuilder;
use rayon::prelude::*;
use serde::Serialize;
use std::{
    error::Error,
    fmt, fs,
    io::Read,
    ops::Range,
    path::PathBuf,
    time::{Duration, Instant},
};

const MAX_PATTERN_BYTES: usize = 16 * 1024;
const MAX_PATTERN_VARIABLES: usize = 64;
const MAX_VARIABLE_NAME_BYTES: usize = 128;
const MAX_RETURNED_BINDINGS: usize = 16;
const MAX_BINDING_VALUES: usize = 8;
const MAX_TOTAL_BINDING_VALUES: usize = 32;
const MAX_PREVIEW_BYTES: usize = 512;
const MAX_BINDING_PREVIEW_BYTES: usize = 128;
const MAX_DIAGNOSTICS: usize = 100;
const PARALLEL_FILE_CHUNK: usize = 8;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AstSearchResult {
    pub path: String,
    pub language: LanguageId,
    pub pattern: String,
    pub matches: Vec<AstSearchMatch>,
    pub diagnostics: Vec<AstSearchDiagnostic>,
    pub summary: AstSearchSummary,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AstSearchMatch {
    pub relative_path: String,
    pub language: LanguageId,
    pub range: SourceRange,
    pub preview: String,
    pub preview_truncated: bool,
    pub bindings: Vec<AstSearchBinding>,
    pub bindings_truncated: bool,
    pub certainty: ParseCertainty,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub certainty_reason: Option<String>,
    pub locator: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enclosing_scope: Option<AstSearchScope>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AstSearchBinding {
    pub name: String,
    pub values: Vec<AstSearchBindingValue>,
    pub values_truncated: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AstSearchBindingValue {
    pub range: SourceRange,
    pub preview: String,
    pub preview_truncated: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AstSearchScope {
    pub ast_kind: String,
    pub range: SourceRange,
    pub preview: String,
    pub preview_truncated: bool,
    pub locator: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AstSearchDiagnostic {
    pub relative_path: String,
    pub code: &'static str,
    pub message: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AstSearchSummary {
    pub files_discovered: usize,
    pub files_filtered: usize,
    pub language_filtered_files: usize,
    pub literal_filtered_files: usize,
    pub files_read: usize,
    pub files_parsed: usize,
    pub files_searched: usize,
    pub unreadable_files: usize,
    pub oversized_files: usize,
    pub failed_files: usize,
    pub parser_degraded_files: usize,
    pub source_bytes: usize,
    pub matches_found: usize,
    pub matches_returned: usize,
    pub result_limit: usize,
    pub result_limit_reached: bool,
    pub literal_prefilter_applied: bool,
    pub potential_kind_prefilter_applied: bool,
    pub diagnostics_omitted: usize,
    pub file_limit_reached: bool,
    pub source_byte_limit_reached: bool,
    pub depth_limit_reached: bool,
    pub elapsed_limit_reached: bool,
}

#[derive(Debug)]
pub struct AstSearchError {
    pub code: &'static str,
    pub message: String,
}

impl fmt::Display for AstSearchError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl Error for AstSearchError {}

struct Candidate {
    path: PathBuf,
    relative_path: String,
}

struct PreparedFile {
    path: PathBuf,
    relative_path: String,
    source: String,
    source_fingerprint: String,
}

struct FileSearch {
    relative_path: String,
    parsed: bool,
    searched: bool,
    parser_degraded: bool,
    elapsed_limit_reached: bool,
    matches_found: usize,
    matches: Vec<AstSearchMatch>,
}

struct SearchScope {
    ast_kind: String,
    bytes: Range<usize>,
}

impl crate::outline::OutlineEngine {
    pub fn search(
        &self,
        path: &str,
        language: LanguageId,
        budgets: RecursiveBudgets,
        pattern_source: &str,
        result_limit: usize,
    ) -> Result<AstSearchResult, AstSearchError> {
        if result_limit == 0 || result_limit > 100 {
            return Err(search_error(
                "invalid_result_limit",
                "ast_search resultLimit must be between 1 and 100",
            ));
        }
        if pattern_source.len() > MAX_PATTERN_BYTES {
            return Err(search_error(
                "invalid_pattern",
                format!("ast_search pattern exceeds {MAX_PATTERN_BYTES} bytes"),
            ));
        }
        let pattern = compile_pattern(language, pattern_source)?;
        if pattern.has_error() {
            return Err(search_error(
                "invalid_pattern",
                "ast_search pattern parsed with an ERROR node; provide a valid pattern or explicit language",
            ));
        }
        let mut variables = pattern
            .defined_vars()
            .into_iter()
            .map(str::to_owned)
            .collect::<Vec<_>>();
        variables.sort();
        if variables.len() > MAX_PATTERN_VARIABLES
            || variables
                .iter()
                .any(|variable| variable.len() > MAX_VARIABLE_NAME_BYTES)
        {
            return Err(search_error(
                "invalid_pattern",
                format!(
                    "ast_search patterns support at most {MAX_PATTERN_VARIABLES} named metavariables of {MAX_VARIABLE_NAME_BYTES} bytes each"
                ),
            ));
        }
        validate_recursive_budgets(budgets)
            .map_err(|error| search_error("invalid_search_budget", error.to_string()))?;

        let started = Instant::now();
        let elapsed_limit = Duration::from_millis(budgets.max_elapsed_ms);
        let deadline = started + elapsed_limit;
        let root = fs::canonicalize(path)
            .map_err(|error| search_error("invalid_search_target", error.to_string()))?;
        let fixed_literal = pattern.fixed_string().into_owned();
        let mut summary = AstSearchSummary {
            files_discovered: 0,
            files_filtered: 0,
            language_filtered_files: 0,
            literal_filtered_files: 0,
            files_read: 0,
            files_parsed: 0,
            files_searched: 0,
            unreadable_files: 0,
            oversized_files: 0,
            failed_files: 0,
            parser_degraded_files: 0,
            source_bytes: 0,
            matches_found: 0,
            matches_returned: 0,
            result_limit,
            result_limit_reached: false,
            literal_prefilter_applied: !fixed_literal.is_empty(),
            potential_kind_prefilter_applied: pattern.potential_kinds().is_some(),
            diagnostics_omitted: 0,
            file_limit_reached: false,
            source_byte_limit_reached: false,
            depth_limit_reached: false,
            elapsed_limit_reached: false,
        };
        let mut diagnostics = Vec::new();
        let mut candidates = if root.is_file() {
            summary.files_discovered = 1;
            let inferred = language_for_path(&root).ok_or_else(|| {
                search_error(
                    "unsupported_search_target",
                    format!("unsupported ast_search file type: {}", root.display()),
                )
            })?;
            if inferred != language {
                return Err(search_error(
                    "search_language_mismatch",
                    format!(
                        "ast_search language {language:?} does not match {}",
                        root.display()
                    ),
                ));
            }
            vec![Candidate {
                relative_path: root
                    .file_name()
                    .map(PathBuf::from)
                    .as_deref()
                    .map(relative_path)
                    .unwrap_or_else(|| relative_path(&root)),
                path: root.clone(),
            }]
        } else if root.is_dir() {
            let mut found = Vec::new();
            let mut walker = WalkBuilder::new(&root);
            walker
                .standard_filters(true)
                .require_git(false)
                .follow_links(false)
                .sort_by_file_path(|left, right| left.cmp(right))
                .max_depth(Some(budgets.max_depth));
            for entry in walker.build() {
                if Instant::now() >= deadline {
                    summary.elapsed_limit_reached = true;
                    break;
                }
                let entry = match entry {
                    Ok(entry) => entry,
                    Err(error) => {
                        summary.unreadable_files += 1;
                        push_diagnostic(
                            &mut diagnostics,
                            &mut summary.diagnostics_omitted,
                            "?".to_owned(),
                            "unreadable",
                            error.to_string(),
                        );
                        continue;
                    }
                };
                if entry.depth() == budgets.max_depth
                    && entry.file_type().is_some_and(|kind| kind.is_dir())
                {
                    summary.depth_limit_reached = true;
                }
                if !entry.file_type().is_some_and(|kind| kind.is_file()) {
                    continue;
                }
                summary.files_discovered += 1;
                if language_for_path(entry.path()) != Some(language) {
                    summary.language_filtered_files += 1;
                    continue;
                }
                if found.len() >= budgets.max_files {
                    summary.file_limit_reached = true;
                    break;
                }
                let canonical = match fs::canonicalize(entry.path()) {
                    Ok(path) => path,
                    Err(error) => {
                        summary.unreadable_files += 1;
                        push_diagnostic(
                            &mut diagnostics,
                            &mut summary.diagnostics_omitted,
                            relative_path(entry.path().strip_prefix(&root).unwrap_or(entry.path())),
                            "unreadable",
                            error.to_string(),
                        );
                        continue;
                    }
                };
                let relative = canonical.strip_prefix(&root).map_err(|_| {
                    search_error(
                        "invalid_search_target",
                        format!("ast_search path escaped its root: {}", canonical.display()),
                    )
                })?;
                let relative = relative_path(relative);
                found.push(Candidate {
                    path: canonical,
                    relative_path: relative,
                });
            }
            found
        } else {
            return Err(search_error(
                "invalid_search_target",
                format!(
                    "ast_search target is neither a file nor directory: {}",
                    root.display()
                ),
            ));
        };
        candidates.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
        summary.files_filtered = summary.language_filtered_files;

        let mut prepared = Vec::new();
        for candidate in candidates {
            if Instant::now() >= deadline {
                summary.elapsed_limit_reached = true;
                break;
            }
            let remaining = budgets
                .max_source_bytes
                .saturating_sub(summary.source_bytes);
            let mut source_bytes = Vec::new();
            let read = fs::File::open(&candidate.path).and_then(|file| {
                file.take(u64::try_from(remaining).unwrap_or(u64::MAX) + 1)
                    .read_to_end(&mut source_bytes)
            });
            if let Err(error) = read {
                summary.unreadable_files += 1;
                push_diagnostic(
                    &mut diagnostics,
                    &mut summary.diagnostics_omitted,
                    candidate.relative_path,
                    "unreadable",
                    error.to_string(),
                );
                continue;
            }
            summary.files_read += 1;
            if source_bytes.len() > remaining {
                summary.oversized_files += 1;
                summary.source_byte_limit_reached = true;
                push_diagnostic(
                    &mut diagnostics,
                    &mut summary.diagnostics_omitted,
                    candidate.relative_path,
                    "sourceBudget",
                    format!("file exceeds the remaining {remaining}-byte search source budget"),
                );
                continue;
            }
            summary.source_bytes += source_bytes.len();
            if !fixed_literal.is_empty()
                && !source_bytes
                    .windows(fixed_literal.len())
                    .any(|window| window == fixed_literal.as_bytes())
            {
                summary.literal_filtered_files += 1;
                continue;
            }
            let source_fingerprint = source_fingerprint(&source_bytes);
            let source = match String::from_utf8(source_bytes) {
                Ok(source) => source,
                Err(error) => {
                    summary.failed_files += 1;
                    push_diagnostic(
                        &mut diagnostics,
                        &mut summary.diagnostics_omitted,
                        candidate.relative_path,
                        "invalidUtf8",
                        error.to_string(),
                    );
                    continue;
                }
            };
            prepared.push(PreparedFile {
                path: candidate.path,
                relative_path: candidate.relative_path,
                source,
                source_fingerprint,
            });
        }
        summary.files_filtered += summary.literal_filtered_files;
        if summary.source_bytes >= budgets.max_source_bytes {
            summary.source_byte_limit_reached = true;
        }

        let mut matches = Vec::new();
        for chunk in prepared.chunks(PARALLEL_FILE_CHUNK) {
            if Instant::now() >= deadline {
                summary.elapsed_limit_reached = true;
                break;
            }
            let materialization_limit = result_limit.saturating_sub(matches.len());
            let mut file_results = chunk
                .par_iter()
                .map(|file| {
                    if Instant::now() >= deadline {
                        return Ok(FileSearch {
                            relative_path: file.relative_path.clone(),
                            parsed: false,
                            searched: false,
                            parser_degraded: false,
                            elapsed_limit_reached: true,
                            matches_found: 0,
                            matches: Vec::new(),
                        });
                    }
                    search_file(
                        file,
                        language,
                        &pattern,
                        &variables,
                        materialization_limit,
                        deadline,
                    )
                })
                .collect::<Result<Vec<_>, AstSearchError>>()?;
            file_results.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
            for mut file in file_results {
                summary.files_parsed += usize::from(file.parsed);
                summary.files_searched += usize::from(file.searched);
                summary.parser_degraded_files += usize::from(file.parser_degraded);
                summary.elapsed_limit_reached |= file.elapsed_limit_reached;
                summary.matches_found += file.matches_found;
                if matches.len() < result_limit {
                    let remaining = result_limit - matches.len();
                    file.matches.truncate(remaining);
                    matches.extend(file.matches);
                }
            }
        }
        matches.sort_by(|left, right| {
            left.relative_path
                .cmp(&right.relative_path)
                .then(left.range.start_byte.cmp(&right.range.start_byte))
                .then(left.range.end_byte.cmp(&right.range.end_byte))
        });
        summary.matches_returned = matches.len();
        summary.result_limit_reached = summary.matches_found > summary.matches_returned;

        Ok(AstSearchResult {
            path: root.to_string_lossy().into_owned(),
            language,
            pattern: pattern_source.to_owned(),
            matches,
            diagnostics,
            summary,
        })
    }
}

fn compile_pattern(language: LanguageId, source: &str) -> Result<Pattern, AstSearchError> {
    let compiled = match language {
        LanguageId::Odin => Pattern::try_new(source, OdinLanguage::Odin),
        language => Pattern::try_new(source, support_language(language)),
    };
    compiled.map_err(|error| {
        search_error(
            "invalid_pattern",
            format!("invalid {language:?} ast_search pattern: {error}"),
        )
    })
}

fn support_language(language: LanguageId) -> SupportLang {
    match language {
        LanguageId::TypeScript => SupportLang::TypeScript,
        LanguageId::Tsx => SupportLang::Tsx,
        LanguageId::Go => SupportLang::Go,
        LanguageId::Rust => SupportLang::Rust,
        LanguageId::CSharp => SupportLang::CSharp,
        LanguageId::Java => SupportLang::Java,
        LanguageId::Kotlin => SupportLang::Kotlin,
        LanguageId::Swift => SupportLang::Swift,
        LanguageId::Markdown => SupportLang::Markdown,
        LanguageId::Odin => unreachable!("Odin uses Tau's custom ast-grep language"),
    }
}

fn search_file(
    file: &PreparedFile,
    language: LanguageId,
    pattern: &Pattern,
    variables: &[String],
    result_limit: usize,
    deadline: Instant,
) -> Result<FileSearch, AstSearchError> {
    match language {
        LanguageId::Odin => {
            let grep = OdinLanguage::Odin.ast_grep(&file.source);
            search_root(
                file,
                language,
                grep.root(),
                pattern,
                variables,
                result_limit,
                deadline,
                &[],
            )
        }
        LanguageId::Markdown => {
            validate_markdown_source(&file.source)
                .map_err(|error| search_error("search_failed", error))?;
            let mut parser = tree_sitter::Parser::new();
            parser
                .set_language(&tree_sitter_md::LANGUAGE.into())
                .map_err(|error| search_error("search_failed", error.to_string()))?;
            let tree = parser.parse(&file.source, None).ok_or_else(|| {
                search_error("search_failed", "Markdown parser returned no syntax tree")
            })?;
            let scopes = extract_markdown_items(tree.root_node(), &file.source)
                .into_iter()
                .map(|item| SearchScope {
                    ast_kind: item.entry.ast_kind,
                    bytes: item.entry.range.start_byte..item.entry.range.end_byte,
                })
                .collect::<Vec<_>>();
            let grep = SupportLang::Markdown.ast_grep(&file.source);
            search_root(
                file,
                language,
                grep.root(),
                pattern,
                variables,
                result_limit,
                deadline,
                &scopes,
            )
        }
        language => {
            let grep = support_language(language).ast_grep(&file.source);
            search_root(
                file,
                language,
                grep.root(),
                pattern,
                variables,
                result_limit,
                deadline,
                &[],
            )
        }
    }
}

fn search_root<D: Doc>(
    file: &PreparedFile,
    language: LanguageId,
    root: Node<D>,
    pattern: &Pattern,
    variables: &[String],
    result_limit: usize,
    deadline: Instant,
    source_scopes: &[SearchScope],
) -> Result<FileSearch, AstSearchError> {
    if Instant::now() >= deadline {
        return Ok(FileSearch {
            relative_path: file.relative_path.clone(),
            parsed: true,
            searched: false,
            parser_degraded: false,
            elapsed_limit_reached: true,
            matches_found: 0,
            matches: Vec::new(),
        });
    }
    let mut recovery_ranges = Vec::new();
    for node in root.dfs() {
        if Instant::now() >= deadline {
            return Ok(FileSearch {
                relative_path: file.relative_path.clone(),
                parsed: true,
                searched: false,
                parser_degraded: !recovery_ranges.is_empty(),
                elapsed_limit_reached: true,
                matches_found: 0,
                matches: Vec::new(),
            });
        }
        if node.is_error() || node.is_missing() {
            recovery_ranges.push(node.range());
        }
    }
    let parser_degraded = !recovery_ranges.is_empty();
    let mut matches_found = 0;
    let mut matches = Vec::new();
    let mut elapsed_limit_reached = false;
    for matched in root.find_all(pattern) {
        if Instant::now() >= deadline {
            elapsed_limit_reached = true;
            break;
        }
        matches_found += 1;
        if matches.len() >= result_limit {
            continue;
        }
        let node = matched.get_node();
        let bytes = node.range();
        let range = source_range(file.source.as_bytes(), bytes.clone());
        let exact = file.source.get(bytes.clone()).ok_or_else(|| {
            search_error(
                "search_failed",
                format!("match range split UTF-8 in {}", file.relative_path),
            )
        })?;
        let (preview, preview_truncated) = bounded_preview(exact, MAX_PREVIEW_BYTES);
        let locator = encode_search_match_locator(
            &file.path.to_string_lossy(),
            language,
            &file.source_fingerprint,
            range.clone(),
            node.kind().as_ref(),
            &preview,
        )
        .map_err(|error| search_error("search_failed", error.to_string()))?;
        let enclosing = source_scopes
            .iter()
            .filter(|scope| scope.bytes.start <= bytes.start && scope.bytes.end >= bytes.end)
            .min_by_key(|scope| scope.bytes.end - scope.bytes.start)
            .map(|scope| (scope.bytes.clone(), scope.ast_kind.clone()))
            .or_else(|| {
                std::iter::once(node.clone())
                    .chain(node.ancestors())
                    .find(|ancestor| is_enclosing_scope(ancestor.kind().as_ref()))
                    .map(|scope| (scope.range(), scope.kind().into_owned()))
            });
        let enclosing_range = enclosing
            .as_ref()
            .map(|(range, _)| range.clone())
            .unwrap_or_else(|| bytes.clone());
        let match_certainty = certainty(&recovery_ranges, &bytes, &enclosing_range);
        let enclosing_scope = enclosing
            .map(|(scope_bytes, scope_kind)| {
                let scope_range = source_range(file.source.as_bytes(), scope_bytes.clone());
                let scope_source = &file.source[scope_bytes.clone()];
                let (scope_preview, scope_preview_truncated) =
                    bounded_preview(scope_source, MAX_PREVIEW_BYTES);
                let scope_locator = encode_search_scope_locator(
                    &file.path.to_string_lossy(),
                    language,
                    &file.source_fingerprint,
                    scope_range.clone(),
                    &scope_kind,
                    &scope_preview,
                )
                .map_err(|error| search_error("search_failed", error.to_string()))?;
                Ok(AstSearchScope {
                    ast_kind: scope_kind,
                    range: scope_range,
                    preview: scope_preview,
                    preview_truncated: scope_preview_truncated,
                    locator: scope_locator,
                })
            })
            .transpose()?;
        let mut bindings = Vec::new();
        let mut bindings_truncated = false;
        let mut total_binding_values = 0;
        for variable in variables {
            let mut values = matched
                .get_env()
                .get_match(variable)
                .cloned()
                .into_iter()
                .chain(matched.get_env().get_multiple_matches(variable))
                .take(MAX_BINDING_VALUES + 1)
                .collect::<Vec<_>>();
            if values.is_empty() {
                continue;
            }
            if bindings.len() >= MAX_RETURNED_BINDINGS
                || total_binding_values >= MAX_TOTAL_BINDING_VALUES
            {
                bindings_truncated = true;
                break;
            }
            let retained_values =
                MAX_BINDING_VALUES.min(MAX_TOTAL_BINDING_VALUES - total_binding_values);
            let values_truncated = values.len() > retained_values;
            values.truncate(retained_values);
            total_binding_values += values.len();
            bindings.push(AstSearchBinding {
                name: variable.clone(),
                values: values
                    .into_iter()
                    .map(|value| {
                        let value_range = value.range();
                        let (preview, preview_truncated) = bounded_preview(
                            &file.source[value_range.clone()],
                            MAX_BINDING_PREVIEW_BYTES,
                        );
                        AstSearchBindingValue {
                            range: source_range(file.source.as_bytes(), value_range),
                            preview,
                            preview_truncated,
                        }
                    })
                    .collect(),
                values_truncated,
            });
        }
        matches.push(AstSearchMatch {
            relative_path: file.relative_path.clone(),
            language,
            range,
            preview,
            preview_truncated,
            bindings,
            bindings_truncated,
            certainty: match_certainty,
            certainty_reason: certainty_reason(match_certainty),
            locator,
            enclosing_scope,
        });
    }
    matches.sort_by(|left, right| {
        left.range
            .start_byte
            .cmp(&right.range.start_byte)
            .then(left.range.end_byte.cmp(&right.range.end_byte))
    });
    Ok(FileSearch {
        relative_path: file.relative_path.clone(),
        parsed: true,
        searched: true,
        parser_degraded,
        elapsed_limit_reached,
        matches_found,
        matches,
    })
}

fn is_enclosing_scope(kind: &str) -> bool {
    kind.contains("declaration")
        || kind.ends_with("_item")
        || matches!(
            kind,
            "arrow_function"
                | "anonymous_function"
                | "anonymous_method_expression"
                | "closure_expression"
                | "constructor"
                | "deinit_declaration"
                | "function_expression"
                | "function_literal"
                | "lambda_expression"
                | "lambda_literal"
                | "local_function_statement"
                | "method_definition"
                | "proc_literal"
                | "procedure"
                | "secondary_constructor"
                | "atx_heading"
                | "setext_heading"
        )
}

fn bounded_preview(source: &str, max_bytes: usize) -> (String, bool) {
    if source.len() <= max_bytes {
        return (source.to_owned(), false);
    }
    let mut end = max_bytes;
    while !source.is_char_boundary(end) {
        end -= 1;
    }
    (source[..end].to_owned(), true)
}

fn push_diagnostic(
    diagnostics: &mut Vec<AstSearchDiagnostic>,
    omitted: &mut usize,
    relative_path: String,
    code: &'static str,
    message: String,
) {
    if diagnostics.len() >= MAX_DIAGNOSTICS {
        *omitted += 1;
        return;
    }
    diagnostics.push(AstSearchDiagnostic {
        relative_path,
        code,
        message,
    });
}

fn search_error(code: &'static str, message: impl Into<String>) -> AstSearchError {
    AstSearchError {
        code,
        message: message.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn budgets() -> RecursiveBudgets {
        RecursiveBudgets {
            max_files: 100,
            max_source_bytes: 1024 * 1024,
            max_depth: 8,
            max_elapsed_ms: 5_000,
        }
    }

    #[test]
    fn odin_metavariables_preserve_match_and_binding_ranges() {
        let directory =
            std::env::temp_dir().join(format!("tau-ast-search-odin-{}", std::process::id()));
        fs::create_dir_all(&directory).expect("search fixture directory");
        let path = directory.join("fixture.odin");
        let source =
            "package fixture\n\nadd :: proc(left, right: int) -> int { return left + right }\n";
        fs::write(&path, source).expect("Odin search fixture");
        let result = crate::outline::OutlineEngine::new()
            .expect("engine")
            .search(
                &path.to_string_lossy(),
                LanguageId::Odin,
                budgets(),
                "$NAME :: proc($$$PARAMS) -> $RESULT { $$$BODY }",
                10,
            )
            .expect("Odin pattern should compile and match");
        assert_eq!(result.summary.matches_found, 1);
        let matched = &result.matches[0];
        assert_eq!(
            &source[matched.range.start_byte..matched.range.end_byte],
            matched.preview
        );
        assert!(
            matched
                .bindings
                .iter()
                .any(|binding| { binding.name == "NAME" && binding.values[0].preview == "add" })
        );
        fs::remove_dir_all(directory).expect("remove search fixture");
    }

    #[test]
    fn rejects_invalid_patterns_before_reading_the_target() {
        let missing =
            std::env::temp_dir().join(format!("tau-ast-missing-search-{}", std::process::id()));
        let error = crate::outline::OutlineEngine::new()
            .expect("engine")
            .search(
                &missing.to_string_lossy(),
                LanguageId::TypeScript,
                budgets(),
                "const one = 1; const two = 2;",
                10,
            )
            .expect_err("multi-node pattern should fail first");
        assert_eq!(error.code, "invalid_pattern");
    }

    #[test]
    fn markdown_matches_return_the_complete_heading_section_scope() {
        let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("fixtures/markdown.md");
        let result = crate::outline::OutlineEngine::new()
            .expect("engine")
            .search(
                &fixture.to_string_lossy(),
                LanguageId::Markdown,
                budgets(),
                "## $HEADING",
                10,
            )
            .expect("Markdown heading pattern should match");
        let installation = result
            .matches
            .iter()
            .find(|matched| matched.preview.contains("Installation"))
            .expect("Installation heading should match");
        let scope = installation
            .enclosing_scope
            .as_ref()
            .expect("Markdown match should have a heading section scope");
        assert!(scope.preview.starts_with("## Installation"));
        assert!(scope.range.end_byte > installation.range.end_byte);
    }
}
