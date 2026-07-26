use crate::outline::{
    DeclarationFilter, LanguageId, OutlineEngine, OutlineEntry, OutlineRowKind, ParseCertainty,
    RecursiveBudgets, RecursiveOutlineEvent, SourceRange, SymbolType,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    error::Error,
    fs,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

mod surfaces;

const MAX_RESULTS: usize = 100;
const MAX_QUERY_CANDIDATES: usize = 10_000;
const MAX_QUERY_WORK: usize = 1_000_000;
const MAX_SIGNATURE_BYTES: usize = 4 * 1024;

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ApiQuery {
    ExactName {
        name: String,
    },
    PrefixName {
        name: String,
    },
    SubstringName {
        name: String,
    },
    FuzzyName {
        name: String,
        #[serde(rename = "maxCandidates")]
        max_candidates: usize,
        #[serde(rename = "maxWork")]
        max_work: usize,
    },
    DeclarationKind {
        #[serde(rename = "declarationKind")]
        declaration_kind: SymbolType,
    },
    Documentation {
        terms: Vec<String>,
        #[serde(rename = "maxCandidates")]
        max_candidates: usize,
        #[serde(rename = "maxWork")]
        max_work: usize,
    },
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ApiSurfaceFilter {
    All,
    Public,
    Private,
    SourceExport,
    PackageSurface,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ApiStatus {
    Yes,
    No,
    Unknown,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ApiVisibility {
    Public,
    Protected,
    Internal,
    PackagePrivate,
    FilePrivate,
    Private,
    Unknown,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ApiImportForm {
    Named,
    Default,
    Namespace,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ApiAccessForm {
    Direct,
    Qualified,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiCallerAccess {
    pub module_path: String,
    pub import_statement: String,
    pub access_expression: String,
    pub form: ApiAccessForm,
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ApiProvenance {
    Exact,
    Inferred,
    Ambiguous,
    Unsupported,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiCandidate {
    pub locator: String,
    pub language: LanguageId,
    pub name: String,
    pub qualified_name: String,
    pub symbol_type: SymbolType,
    pub signature: String,
    pub defining_file: String,
    pub range: SourceRange,
    pub visibility: ApiVisibility,
    pub source_export: ApiStatus,
    pub package_surface: ApiStatus,
    pub internal_only: ApiStatus,
    pub re_export_chain: Vec<String>,
    pub caller_access: Option<ApiCallerAccess>,
    pub provenance: ApiProvenance,
    pub certainty: ParseCertainty,
    pub certainty_reason: Option<String>,
    pub uncertainty: Option<String>,
    #[serde(skip)]
    owner_name: String,
    #[serde(skip)]
    access_owner: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiDiscoverySummary {
    pub files_scanned: usize,
    pub declarations_considered: usize,
    pub results_returned: usize,
    pub result_limit: usize,
    pub omitted_candidates: usize,
    pub candidate_limit_reached: bool,
    pub work_limit_reached: bool,
    pub resolution_diagnostics: usize,
    pub total_source_bytes: usize,
    pub file_limit_reached: bool,
    pub source_byte_limit_reached: bool,
    pub depth_limit_reached: bool,
    pub elapsed_limit_reached: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiDiscoveryResult {
    pub path: String,
    pub candidates: Vec<ApiCandidate>,
    pub summary: ApiDiscoverySummary,
}

#[derive(Clone)]
enum TsExportBinding {
    Local {
        local: String,
        exported: String,
        form: ApiImportForm,
        provenance: ApiProvenance,
    },
    Remote {
        source: String,
        imported: String,
        exported: String,
    },
    Star {
        source: String,
    },
    Namespace {
        source: String,
        exported: String,
    },
}

#[derive(Clone)]
struct TsModule {
    relative_path: String,
    local_names: BTreeSet<String>,
    imports: BTreeMap<String, (String, String)>,
    bindings: Vec<TsExportBinding>,
}

#[derive(Clone, Eq, PartialEq)]
struct TsResolvedExport {
    target_file: PathBuf,
    target_name: String,
    exported_name: String,
    form: ApiImportForm,
    chain: Vec<String>,
    provenance: ApiProvenance,
    namespace_export: bool,
}

#[derive(Clone, Eq, Ord, PartialEq, PartialOrd)]
struct TsEntrypoint {
    path: PathBuf,
    module_path: String,
    provenance: ApiProvenance,
    metadata_backed: bool,
}

impl OutlineEngine {
    pub fn discover_api(
        &self,
        path: &str,
        budgets: RecursiveBudgets,
        query: ApiQuery,
        surface: ApiSurfaceFilter,
        result_limit: usize,
    ) -> Result<ApiDiscoveryResult, Box<dyn Error>> {
        validate_query(&query, result_limit)?;
        let started = Instant::now();
        let elapsed_limit = Duration::from_millis(budgets.max_elapsed_ms);
        let deadline = started + elapsed_limit;
        let root = fs::canonicalize(path)?;
        if !root.is_dir() {
            return Err(
                format!("API discovery scope is not a directory: {}", root.display()).into(),
            );
        }

        let include_private = matches!(surface, ApiSurfaceFilter::All | ApiSurfaceFilter::Private);
        let declaration_filter = match &query {
            ApiQuery::ExactName { name } => Some(DeclarationFilter::ExactName(name.clone())),
            ApiQuery::PrefixName { name } => {
                Some(DeclarationFilter::PrefixName(name.to_lowercase()))
            }
            ApiQuery::SubstringName { name } => {
                Some(DeclarationFilter::SubstringName(name.to_lowercase()))
            }
            ApiQuery::DeclarationKind { declaration_kind } => {
                Some(DeclarationFilter::Kind(*declaration_kind))
            }
            ApiQuery::FuzzyName { .. } | ApiQuery::Documentation { .. } => None,
        };
        let mut files = Vec::new();
        let recursive = self.outline_recursive(
            &root.to_string_lossy(),
            budgets,
            include_private,
            true,
            &[],
            declaration_filter.as_ref(),
            &mut |event| {
                if let RecursiveOutlineEvent::File { file, .. } = event {
                    files.push(file);
                }
                Ok(())
            },
        )?;

        let mut candidates = Vec::new();
        let mut modules = BTreeMap::new();
        for file in &files {
            let file_path = PathBuf::from(&file.path);
            let relative = relative_path(file_path.strip_prefix(&root).unwrap_or(&file_path));
            let typescript = matches!(file.language, LanguageId::TypeScript | LanguageId::Tsx);
            let mut module = typescript.then(|| TsModule {
                relative_path: relative,
                local_names: BTreeSet::new(),
                imports: BTreeMap::new(),
                bindings: Vec::new(),
            });

            for item in &file.items {
                if item.row_kind != OutlineRowKind::Declaration {
                    continue;
                }
                if let Some(module) = &mut module {
                    module.local_names.insert(item.entry.name.clone());
                    if let Some((exported, form)) = direct_typescript_export(&item.entry) {
                        module.bindings.push(TsExportBinding::Local {
                            local: item.entry.name.clone(),
                            exported,
                            form,
                            provenance: ApiProvenance::Exact,
                        });
                    }
                }
                if let Some(candidate) = candidate_from_entry(
                    &item.entry,
                    &item.entry.name,
                    file.language,
                    &file.path,
                    declaration_visibility(file.language, &item.entry.signature, item.is_exported),
                    !typescript && file.language != LanguageId::Markdown && item.is_exported,
                ) {
                    candidates.push(candidate);
                }
                for member in &item.members {
                    if let Some(candidate) = candidate_from_entry(
                        &member.entry,
                        &item.entry.name,
                        file.language,
                        &file.path,
                        declaration_visibility(
                            file.language,
                            &member.entry.signature,
                            item.is_exported && member.is_public,
                        ),
                        !typescript
                            && file.language != LanguageId::Markdown
                            && item.is_exported
                            && member.is_public,
                    ) {
                        candidates.push(candidate);
                    }
                }
            }

            if let Some(mut module) = module {
                for item in &file.items {
                    if item.row_kind == OutlineRowKind::Import {
                        module
                            .imports
                            .extend(parse_typescript_import(&item.entry.signature));
                    } else if item.row_kind == OutlineRowKind::Export {
                        module
                            .bindings
                            .extend(parse_typescript_export(&item.entry.signature));
                    }
                }
                module.bindings = module
                    .bindings
                    .into_iter()
                    .map(|binding| match binding {
                        TsExportBinding::Local {
                            local,
                            exported,
                            form,
                            provenance,
                        } if !module.local_names.contains(&local) => {
                            module.imports.get(&local).map_or(
                                TsExportBinding::Local {
                                    local: local.clone(),
                                    exported: exported.clone(),
                                    form,
                                    provenance,
                                },
                                |(source, imported)| {
                                    if imported == "*" {
                                        TsExportBinding::Namespace {
                                            source: source.clone(),
                                            exported,
                                        }
                                    } else {
                                        TsExportBinding::Remote {
                                            source: source.clone(),
                                            imported: imported.clone(),
                                            exported,
                                        }
                                    }
                                },
                            )
                        }
                        binding => binding,
                    })
                    .collect();
                let explicitly_bound = module
                    .bindings
                    .iter()
                    .filter_map(|binding| match binding {
                        TsExportBinding::Local { local, .. } => Some(local.clone()),
                        _ => None,
                    })
                    .collect::<BTreeSet<_>>();
                for item in file
                    .items
                    .iter()
                    .filter(|item| item.row_kind == OutlineRowKind::Declaration && item.is_exported)
                {
                    if !explicitly_bound.contains(&item.entry.name) {
                        module.bindings.push(TsExportBinding::Local {
                            local: item.entry.name.clone(),
                            exported: item.entry.name.clone(),
                            form: ApiImportForm::Named,
                            provenance: ApiProvenance::Inferred,
                        });
                    }
                }
                modules.insert(file_path, module);
            }
        }

        if declaration_filter.is_some() {
            candidates.retain(|candidate| query_score(candidate, &query).is_some());
        }
        let mut resolution_diagnostics = Vec::new();
        let mut resolution_elapsed = started.elapsed() >= elapsed_limit;
        if !resolution_elapsed
            && candidates.iter().any(|candidate| {
                matches!(candidate.language, LanguageId::TypeScript | LanguageId::Tsx)
            })
        {
            apply_typescript_surfaces(
                &root,
                &modules,
                &mut candidates,
                &mut resolution_diagnostics,
            );
            resolution_elapsed = started.elapsed() >= elapsed_limit;
        }
        if !resolution_elapsed
            && candidates.iter().any(|candidate| {
                !matches!(candidate.language, LanguageId::TypeScript | LanguageId::Tsx)
            })
        {
            resolution_elapsed = surfaces::apply_non_typescript_surfaces(
                self,
                &root,
                &files,
                &mut candidates,
                &mut resolution_diagnostics,
                deadline,
            );
        }
        candidates.sort_by(|left, right| {
            left.defining_file
                .cmp(&right.defining_file)
                .then(left.range.start_byte.cmp(&right.range.start_byte))
                .then(left.name.cmp(&right.name))
        });

        let (max_candidates, max_work) = match &query {
            ApiQuery::FuzzyName {
                max_candidates,
                max_work,
                ..
            }
            | ApiQuery::Documentation {
                max_candidates,
                max_work,
                ..
            } => (Some(*max_candidates), Some(*max_work)),
            _ => (None, None),
        };
        let eligible = candidates
            .into_iter()
            .filter(|candidate| surface_matches(candidate, surface))
            .collect::<Vec<_>>();
        let eligible_count = eligible.len();
        let candidate_limit_reached = max_candidates.is_some_and(|limit| eligible_count > limit);
        let mut work: usize = 0;
        let mut work_limit_reached = false;
        let mut declarations_considered = 0;
        let mut matched = Vec::new();
        for candidate in eligible
            .into_iter()
            .take(max_candidates.unwrap_or(usize::MAX))
        {
            let candidate_work = query_work(&candidate, &query);
            if max_work.is_some_and(|limit| work.saturating_add(candidate_work) > limit) {
                work_limit_reached = true;
                break;
            }
            work = work.saturating_add(candidate_work);
            declarations_considered += 1;
            if let Some(score) = query_score(&candidate, &query) {
                matched.push((score, candidate));
            }
        }
        matched.sort_by(|left, right| {
            left.0
                .cmp(&right.0)
                .then(left.1.name.to_lowercase().cmp(&right.1.name.to_lowercase()))
                .then(left.1.defining_file.cmp(&right.1.defining_file))
                .then(left.1.range.start_byte.cmp(&right.1.range.start_byte))
        });
        let total_matched = matched.len();
        matched.truncate(result_limit);
        let candidates = matched
            .into_iter()
            .map(|(_, candidate)| candidate)
            .collect::<Vec<_>>();
        let results_returned = candidates.len();
        let omitted_candidates = total_matched
            .saturating_sub(results_returned)
            .saturating_add(eligible_count.saturating_sub(declarations_considered));

        Ok(ApiDiscoveryResult {
            path: root.to_string_lossy().into_owned(),
            candidates,
            summary: ApiDiscoverySummary {
                files_scanned: files.len(),
                declarations_considered,
                results_returned,
                result_limit,
                omitted_candidates,
                candidate_limit_reached,
                work_limit_reached,
                resolution_diagnostics: resolution_diagnostics.len(),
                total_source_bytes: recursive.total_byte_length,
                file_limit_reached: recursive.file_limit_reached,
                source_byte_limit_reached: recursive.source_byte_limit_reached,
                depth_limit_reached: recursive.depth_limit_reached,
                elapsed_limit_reached: recursive.elapsed_limit_reached
                    || resolution_elapsed
                    || started.elapsed() >= elapsed_limit,
            },
        })
    }
}

fn validate_query(query: &ApiQuery, result_limit: usize) -> Result<(), Box<dyn Error>> {
    if result_limit == 0 || result_limit > MAX_RESULTS {
        return Err(
            format!("API discovery resultLimit must be between 1 and {MAX_RESULTS}").into(),
        );
    }
    match query {
        ApiQuery::ExactName { name }
        | ApiQuery::PrefixName { name }
        | ApiQuery::SubstringName { name } => {
            if name.trim().is_empty() {
                return Err("API discovery name must not be empty".into());
            }
        }
        ApiQuery::FuzzyName {
            name,
            max_candidates,
            max_work,
        } => {
            if name.trim().is_empty() {
                return Err("API discovery name must not be empty".into());
            }
            validate_query_limits(*max_candidates, *max_work)?;
        }
        ApiQuery::Documentation {
            terms,
            max_candidates,
            max_work,
        } => {
            if terms.is_empty() || terms.iter().any(|term| term.trim().is_empty()) {
                return Err("API discovery documentation terms must not be empty".into());
            }
            validate_query_limits(*max_candidates, *max_work)?;
        }
        ApiQuery::DeclarationKind { .. } => {}
    }
    Ok(())
}

fn validate_query_limits(max_candidates: usize, max_work: usize) -> Result<(), Box<dyn Error>> {
    if max_candidates == 0 || max_candidates > MAX_QUERY_CANDIDATES {
        return Err(format!(
            "API discovery maxCandidates must be between 1 and {MAX_QUERY_CANDIDATES}"
        )
        .into());
    }
    if max_work == 0 || max_work > MAX_QUERY_WORK {
        return Err(format!("API discovery maxWork must be between 1 and {MAX_QUERY_WORK}").into());
    }
    Ok(())
}

fn candidate_from_entry(
    entry: &OutlineEntry,
    owner_name: &str,
    language: LanguageId,
    defining_file: &str,
    visibility: ApiVisibility,
    source_exported: bool,
) -> Option<ApiCandidate> {
    if language == LanguageId::Swift
        && entry.symbol_type == SymbolType::Namespace
        && entry.qualified_name.starts_with("extension ")
    {
        return None;
    }
    let locator = entry.locator.clone()?;
    let source_export = if source_exported {
        ApiStatus::Yes
    } else {
        ApiStatus::No
    };
    let internal_only =
        if visibility != ApiVisibility::Public && visibility != ApiVisibility::Unknown {
            ApiStatus::Yes
        } else if matches!(language, LanguageId::TypeScript | LanguageId::Tsx) {
            ApiStatus::Unknown
        } else {
            ApiStatus::Unknown
        };
    Some(ApiCandidate {
        locator,
        language,
        name: entry.name.clone(),
        qualified_name: entry.qualified_name.clone(),
        symbol_type: entry.symbol_type,
        signature: compact_signature(&entry.signature),
        defining_file: defining_file.to_owned(),
        range: entry.range.clone(),
        visibility,
        source_export,
        package_surface: if language == LanguageId::Markdown {
            ApiStatus::No
        } else {
            ApiStatus::Unknown
        },
        internal_only,
        re_export_chain: Vec::new(),
        caller_access: None,
        provenance: if matches!(language, LanguageId::TypeScript | LanguageId::Tsx) {
            ApiProvenance::Exact
        } else {
            ApiProvenance::Inferred
        },
        certainty: entry.certainty,
        certainty_reason: entry.certainty_reason.clone(),
        uncertainty: None,
        owner_name: owner_name.to_owned(),
        access_owner: if entry.name == owner_name {
            owner_name.to_owned()
        } else {
            let parent = entry
                .qualified_name
                .rsplit_once('.')
                .map_or(entry.qualified_name.as_str(), |(parent, _)| parent);
            parent
                .split('.')
                .position(|segment| segment == owner_name)
                .map(|index| parent.split('.').skip(index).collect::<Vec<_>>().join("."))
                .unwrap_or_else(|| owner_name.to_owned())
        },
    })
}

fn declaration_visibility(
    language: LanguageId,
    signature: &str,
    externally_public: bool,
) -> ApiVisibility {
    if language == LanguageId::Markdown {
        return ApiVisibility::Unknown;
    }
    let declaration = signature
        .lines()
        .find(|line| {
            let line = line.trim_start();
            !line.is_empty()
                && !line.starts_with("//")
                && !line.starts_with("/*")
                && !line.starts_with('*')
                && !line.starts_with('@')
                && !line.starts_with("#[")
        })
        .unwrap_or(signature);
    let words = declaration
        .split(|character: char| !(character.is_alphanumeric() || character == '_'))
        .collect::<BTreeSet<_>>();
    if signature.contains("fileprivate ") {
        ApiVisibility::FilePrivate
    } else if words.contains("private") || signature.contains("@(private") {
        if language == LanguageId::Odin && signature.contains("private=\"file\"") {
            ApiVisibility::FilePrivate
        } else {
            ApiVisibility::Private
        }
    } else if words.contains("protected") {
        ApiVisibility::Protected
    } else if signature.contains("pub(crate)")
        || words.contains("internal")
        || (language == LanguageId::Swift && words.contains("package"))
    {
        ApiVisibility::Internal
    } else if externally_public {
        ApiVisibility::Public
    } else {
        match language {
            LanguageId::Java => ApiVisibility::PackagePrivate,
            LanguageId::CSharp | LanguageId::Swift => ApiVisibility::Internal,
            _ => ApiVisibility::Private,
        }
    }
}

fn compact_signature(signature: &str) -> String {
    if signature.len() <= MAX_SIGNATURE_BYTES {
        return signature.to_owned();
    }
    let mut end = MAX_SIGNATURE_BYTES;
    while !signature.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}\n…", signature[..end].trim_end())
}

fn direct_typescript_export(entry: &OutlineEntry) -> Option<(String, ApiImportForm)> {
    for line in entry.signature.lines() {
        let line = line.trim_start();
        let Some(exported) = line.strip_prefix("export ") else {
            continue;
        };
        if exported.starts_with("default ") {
            return Some(("default".to_owned(), ApiImportForm::Default));
        }
        return Some((entry.name.clone(), ApiImportForm::Named));
    }
    None
}

fn parse_typescript_export(signature: &str) -> Vec<TsExportBinding> {
    let Some(mut clause) = signature.trim().strip_prefix("export ") else {
        return Vec::new();
    };
    clause = clause.trim().trim_end_matches(';').trim_end();
    if let Some(rest) = clause.strip_prefix("type ") {
        clause = rest.trim();
    }
    let (clause, source) = clause
        .rsplit_once(" from ")
        .map_or((clause, None), |(left, right)| {
            (left.trim(), unquote(right.trim().trim_end_matches(';')))
        });
    if let Some(namespace) = clause.strip_prefix("* as ") {
        return source.map_or_else(Vec::new, |source| {
            vec![TsExportBinding::Namespace {
                source,
                exported: clean_name(namespace),
            }]
        });
    }
    if clause.starts_with('*') {
        return source.map_or_else(Vec::new, |source| vec![TsExportBinding::Star { source }]);
    }
    let Some(specifiers) = clause
        .strip_prefix('{')
        .and_then(|value| value.strip_suffix('}'))
    else {
        return Vec::new();
    };
    specifiers
        .split(',')
        .filter_map(|specifier| {
            let specifier = specifier
                .trim()
                .strip_prefix("type ")
                .unwrap_or(specifier.trim());
            if specifier.is_empty() {
                return None;
            }
            let (name, alias) = specifier
                .split_once(" as ")
                .map_or((specifier, specifier), |(name, alias)| (name, alias));
            let name = clean_name(name);
            let alias = clean_name(alias);
            Some(match &source {
                Some(source) => TsExportBinding::Remote {
                    source: source.clone(),
                    imported: name,
                    exported: alias,
                },
                None => TsExportBinding::Local {
                    local: name,
                    form: if alias == "default" {
                        ApiImportForm::Default
                    } else {
                        ApiImportForm::Named
                    },
                    exported: alias,
                    provenance: ApiProvenance::Exact,
                },
            })
        })
        .collect()
}

fn parse_typescript_import(signature: &str) -> BTreeMap<String, (String, String)> {
    let mut imports = BTreeMap::new();
    let Some(mut clause) = signature.trim().strip_prefix("import ") else {
        return imports;
    };
    clause = clause.trim();
    if let Some(rest) = clause.strip_prefix("type ") {
        clause = rest.trim();
    }
    let Some((bindings, source)) = clause.rsplit_once(" from ") else {
        return imports;
    };
    let Some(source) = unquote(source.trim().trim_end_matches(';')) else {
        return imports;
    };
    let mut bindings = bindings.trim();
    if !bindings.starts_with(['{', '*']) {
        let (default_binding, remaining) = bindings
            .split_once(',')
            .map_or((bindings, ""), |(default_binding, remaining)| {
                (default_binding, remaining.trim())
            });
        let local = clean_name(default_binding);
        if !local.is_empty() {
            imports.insert(local, (source.clone(), "default".to_owned()));
        }
        bindings = remaining;
    }
    if let Some(local) = bindings.strip_prefix("* as ").map(clean_name) {
        if !local.is_empty() {
            imports.insert(local, (source.clone(), "*".to_owned()));
        }
    } else if let Some(specifiers) = bindings
        .strip_prefix('{')
        .and_then(|value| value.strip_suffix('}'))
    {
        for specifier in specifiers.split(',') {
            let specifier = specifier
                .trim()
                .strip_prefix("type ")
                .unwrap_or(specifier.trim());
            let (imported, local) = specifier
                .split_once(" as ")
                .map_or((specifier, specifier), |(imported, local)| {
                    (imported, local)
                });
            if !local.trim().is_empty() {
                imports.insert(clean_name(local), (source.clone(), clean_name(imported)));
            }
        }
    }
    imports
}

fn clean_name(value: &str) -> String {
    value
        .trim()
        .trim_matches(|character| matches!(character, '\'' | '"' | ';'))
        .to_owned()
}

fn unquote(value: &str) -> Option<String> {
    let first = value.chars().next()?;
    let last = value.chars().last()?;
    (matches!(first, '\'' | '"') && first == last && value.len() >= 2)
        .then(|| value[1..value.len() - 1].to_owned())
}

fn apply_typescript_surfaces(
    root: &Path,
    modules: &BTreeMap<PathBuf, TsModule>,
    candidates: &mut [ApiCandidate],
    diagnostics: &mut Vec<String>,
) {
    let entrypoints = typescript_entrypoints(root, modules, diagnostics);
    let mut package_cache = BTreeMap::new();
    let mut package_diagnostics = Vec::new();
    for entrypoint in &entrypoints {
        let _ = resolve_typescript_module(
            &entrypoint.path,
            modules,
            &mut BTreeSet::new(),
            &mut package_cache,
            &mut package_diagnostics,
        );
    }
    let package_resolution_incomplete = !package_diagnostics.is_empty();
    diagnostics.extend(package_diagnostics);

    let mut cache = BTreeMap::new();
    for path in modules.keys() {
        let _ =
            resolve_typescript_module(path, modules, &mut BTreeSet::new(), &mut cache, diagnostics);
    }

    for (module_path, exports) in &cache {
        let module_import_path = import_path(root, module_path);
        for exported in exports {
            for candidate in candidates.iter_mut().filter(|candidate| {
                candidate.defining_file == exported.target_file.to_string_lossy()
                    && candidate.owner_name == exported.target_name
                    && candidate.visibility == ApiVisibility::Public
            }) {
                candidate.source_export = ApiStatus::Yes;
                candidate.caller_access = Some(typescript_caller_access(
                    &module_import_path,
                    candidate,
                    exported,
                ));
                candidate.re_export_chain = exported.chain.clone();
                candidate.provenance = candidate.provenance.max(exported.provenance);
            }
        }
    }

    for entrypoint in entrypoints {
        let Some(exports) = package_cache.get(&entrypoint.path) else {
            continue;
        };
        let entry_import_path = entrypoint.module_path;
        for exported in exports {
            for candidate in candidates.iter_mut().filter(|candidate| {
                candidate.defining_file == exported.target_file.to_string_lossy()
                    && candidate.owner_name == exported.target_name
                    && candidate.visibility == ApiVisibility::Public
            }) {
                let caller_access =
                    typescript_caller_access(&entry_import_path, candidate, exported);
                if candidate.package_surface == ApiStatus::Yes
                    && candidate.caller_access.as_ref() != Some(&caller_access)
                {
                    candidate.provenance = ApiProvenance::Ambiguous;
                    candidate.uncertainty = Some(
                        "multiple package-surface import paths or exported names resolve to this declaration"
                            .to_owned(),
                    );
                }
                if candidate.package_surface != ApiStatus::Yes {
                    candidate.caller_access = Some(caller_access);
                    candidate.re_export_chain = exported.chain.clone();
                }
                candidate.package_surface = ApiStatus::Yes;
                candidate.internal_only = ApiStatus::No;
                candidate.provenance = candidate.provenance.max(exported.provenance);
                candidate.provenance = candidate.provenance.max(entrypoint.provenance);
                if entrypoint.provenance == ApiProvenance::Inferred
                    && candidate.uncertainty.is_none()
                {
                    candidate.uncertainty = Some(if entrypoint.metadata_backed {
                        "package metadata points to built output; caller access uses the checked-in source entrypoint"
                            .to_owned()
                    } else {
                        "package-surface selection is inferred from the scoped directory or entrypoint convention"
                            .to_owned()
                    });
                }
            }
        }
    }

    for candidate in candidates
        .iter_mut()
        .filter(|candidate| matches!(candidate.language, LanguageId::TypeScript | LanguageId::Tsx))
    {
        if candidate.package_surface != ApiStatus::Yes {
            if package_resolution_incomplete {
                candidate.package_surface = ApiStatus::Unknown;
                candidate.internal_only = ApiStatus::Unknown;
                if candidate.source_export == ApiStatus::Yes {
                    candidate.provenance = ApiProvenance::Ambiguous;
                    candidate.uncertainty = Some(
                        "package-surface resolution is incomplete for the scoped entrypoint"
                            .to_owned(),
                    );
                }
            } else {
                candidate.package_surface = ApiStatus::No;
                candidate.internal_only = ApiStatus::Yes;
            }
        }
        if candidate.source_export == ApiStatus::No {
            candidate.caller_access = None;
        }
        if candidate.source_export == ApiStatus::Yes && candidate.caller_access.is_none() {
            let module_path = import_path(root, Path::new(&candidate.defining_file));
            candidate.caller_access = Some(ApiCallerAccess {
                module_path: module_path.clone(),
                import_statement: format!(
                    "import {{ {} }} from {module_path:?};",
                    candidate.owner_name
                ),
                access_expression: if candidate.name == candidate.owner_name {
                    candidate.owner_name.clone()
                } else {
                    format!("{}.{}", candidate.access_owner, candidate.name)
                },
                form: if candidate.name == candidate.owner_name {
                    ApiAccessForm::Direct
                } else {
                    ApiAccessForm::Qualified
                },
            });
            candidate.provenance = ApiProvenance::Inferred;
        }
    }
}

fn typescript_caller_access(
    module_path: &str,
    candidate: &ApiCandidate,
    exported: &TsResolvedExport,
) -> ApiCallerAccess {
    let (import_statement, binding) = match exported.form {
        ApiImportForm::Default => (
            format!("import {} from {module_path:?};", candidate.owner_name),
            candidate.owner_name.clone(),
        ),
        ApiImportForm::Named => (
            format!(
                "import {{ {} }} from {module_path:?};",
                exported.exported_name
            ),
            exported.exported_name.clone(),
        ),
        ApiImportForm::Namespace => (
            format!(
                "import {{ {} }} from {module_path:?};",
                exported.exported_name
            ),
            format!("{}.{}", exported.exported_name, exported.target_name),
        ),
    };
    let direct =
        candidate.name == candidate.owner_name && exported.form != ApiImportForm::Namespace;
    ApiCallerAccess {
        module_path: module_path.to_owned(),
        import_statement,
        access_expression: if direct {
            binding
        } else if exported.form == ApiImportForm::Namespace {
            if candidate.name == candidate.owner_name {
                binding
            } else {
                format!("{binding}.{}", candidate.name)
            }
        } else {
            let suffix = candidate
                .access_owner
                .strip_prefix(&candidate.owner_name)
                .unwrap_or("");
            format!("{binding}{suffix}.{}", candidate.name)
        },
        form: if direct {
            ApiAccessForm::Direct
        } else {
            ApiAccessForm::Qualified
        },
    }
}

fn resolve_typescript_module(
    path: &Path,
    modules: &BTreeMap<PathBuf, TsModule>,
    visiting: &mut BTreeSet<PathBuf>,
    cache: &mut BTreeMap<PathBuf, Vec<TsResolvedExport>>,
    diagnostics: &mut Vec<String>,
) -> Vec<TsResolvedExport> {
    if let Some(cached) = cache.get(path) {
        return cached.clone();
    }
    if !visiting.insert(path.to_path_buf()) {
        diagnostics.push(format!("cyclic TypeScript re-export at {}", path.display()));
        return Vec::new();
    }
    let Some(module) = modules.get(path) else {
        visiting.remove(path);
        return Vec::new();
    };
    let mut resolved = Vec::new();
    for binding in module.bindings.clone() {
        match binding {
            TsExportBinding::Local {
                local,
                exported,
                form,
                provenance,
            } => {
                if module.local_names.contains(&local) {
                    resolved.push(TsResolvedExport {
                        target_file: path.to_path_buf(),
                        target_name: local,
                        exported_name: exported,
                        form,
                        chain: vec![module.relative_path.clone()],
                        provenance,
                        namespace_export: false,
                    });
                }
            }
            TsExportBinding::Remote {
                source,
                imported,
                exported,
            } => {
                let Some(target) = resolve_typescript_source(path, &source, modules, diagnostics)
                else {
                    continue;
                };
                for mut candidate in
                    resolve_typescript_module(&target, modules, visiting, cache, diagnostics)
                        .into_iter()
                        .filter(|candidate| candidate.exported_name == imported)
                {
                    candidate.exported_name = exported.clone();
                    candidate.form = if exported == "default" {
                        ApiImportForm::Default
                    } else {
                        ApiImportForm::Named
                    };
                    candidate.chain.insert(0, module.relative_path.clone());
                    resolved.push(candidate);
                }
            }
            TsExportBinding::Star { source } => {
                let Some(target) = resolve_typescript_source(path, &source, modules, diagnostics)
                else {
                    continue;
                };
                for mut candidate in
                    resolve_typescript_module(&target, modules, visiting, cache, diagnostics)
                        .into_iter()
                        .filter(|candidate| candidate.exported_name != "default")
                {
                    candidate.chain.insert(0, module.relative_path.clone());
                    resolved.push(candidate);
                }
            }
            TsExportBinding::Namespace { source, exported } => {
                let Some(target) = resolve_typescript_source(path, &source, modules, diagnostics)
                else {
                    continue;
                };
                for mut candidate in
                    resolve_typescript_module(&target, modules, visiting, cache, diagnostics)
                {
                    candidate.exported_name = exported.clone();
                    candidate.form = ApiImportForm::Namespace;
                    candidate.chain.insert(0, module.relative_path.clone());
                    candidate.namespace_export = true;
                    resolved.push(candidate);
                }
            }
        }
    }
    visiting.remove(path);
    resolved.sort_by(|left, right| {
        left.exported_name
            .cmp(&right.exported_name)
            .then(left.target_file.cmp(&right.target_file))
            .then(left.target_name.cmp(&right.target_name))
            .then(left.chain.cmp(&right.chain))
    });
    let conflicts = resolved.iter().fold(
        BTreeMap::<String, BTreeSet<(PathBuf, String)>>::new(),
        |mut map, export| {
            if !export.namespace_export {
                map.entry(export.exported_name.clone())
                    .or_default()
                    .insert((export.target_file.clone(), export.target_name.clone()));
            }
            map
        },
    );
    for export in &mut resolved {
        if conflicts
            .get(&export.exported_name)
            .is_some_and(|targets| targets.len() > 1)
        {
            export.provenance = ApiProvenance::Ambiguous;
        }
    }
    resolved.dedup();
    cache.insert(path.to_path_buf(), resolved.clone());
    resolved
}

fn typescript_entrypoints(
    root: &Path,
    modules: &BTreeMap<PathBuf, TsModule>,
    diagnostics: &mut Vec<String>,
) -> Vec<TsEntrypoint> {
    let mut entrypoints = BTreeSet::new();
    let mut package_roots = BTreeSet::new();
    for path in modules.keys() {
        let mut directory = path.parent();
        while let Some(current) = directory.filter(|current| current.starts_with(root)) {
            if current.join("package.json").is_file() {
                package_roots.insert(current.to_path_buf());
            }
            if current == root {
                break;
            }
            directory = current.parent();
        }
    }
    for package_root in package_roots {
        let manifest_path = package_root.join("package.json");
        let manifest = match fs::read_to_string(&manifest_path)
            .ok()
            .and_then(|source| serde_json::from_str::<serde_json::Value>(&source).ok())
        {
            Some(manifest) => manifest,
            None => {
                diagnostics.push(format!(
                    "could not parse TypeScript package metadata at {}",
                    manifest_path.display()
                ));
                continue;
            }
        };
        let Some(package_name) = manifest.get("name").and_then(|value| value.as_str()) else {
            continue;
        };
        let mut targets = Vec::new();
        for field in ["source", "module", "main", "types"] {
            if let Some(target) = manifest.get(field).and_then(|value| value.as_str()) {
                targets.push(target.to_owned());
            }
        }
        if let Some(exports) = manifest.get("exports") {
            if let Some(exports) = exports
                .as_object()
                .filter(|exports| exports.keys().any(|key| key.starts_with('.')))
            {
                for (key, value) in exports {
                    let mut subpath_targets = Vec::new();
                    collect_typescript_export_targets(value, &mut subpath_targets);
                    if key == "." {
                        targets.extend(subpath_targets);
                    } else if let Some(path) = subpath_targets.iter().find_map(|target| {
                        resolve_typescript_entry_target(&package_root, target, modules)
                    }) {
                        entrypoints.insert(TsEntrypoint {
                            path,
                            module_path: format!("{}{}", package_name, &key[1..]),
                            provenance: ApiProvenance::Exact,
                            metadata_backed: true,
                        });
                    }
                }
            } else {
                collect_typescript_export_targets(exports, &mut targets);
            }
        }
        let direct = targets
            .iter()
            .find_map(|target| resolve_typescript_entry_target(&package_root, target, modules));
        let direct_target = direct.is_some();
        let path = direct.or_else(|| {
            [
                "index.ts",
                "index.tsx",
                "mod.ts",
                "mod.tsx",
                "src/index.ts",
                "src/index.tsx",
                "src/mod.ts",
                "src/mod.tsx",
            ]
            .into_iter()
            .find_map(|target| resolve_typescript_entry_target(&package_root, target, modules))
        });
        if let Some(path) = path {
            entrypoints.insert(TsEntrypoint {
                path,
                module_path: package_name.to_owned(),
                provenance: if direct_target {
                    ApiProvenance::Exact
                } else {
                    ApiProvenance::Inferred
                },
                metadata_backed: true,
            });
        }
    }
    for path in modules.keys() {
        if entrypoints
            .iter()
            .any(|entrypoint| entrypoint.metadata_backed && entrypoint.path == *path)
        {
            continue;
        }
        let Some(file_name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        let parent = path.parent();
        let provenance = match file_name {
            "mod.ts" | "mod.tsx" if parent == Some(root) => Some(ApiProvenance::Exact),
            "index.ts" | "index.tsx" if parent == Some(root) => Some(ApiProvenance::Inferred),
            "mod.ts" | "mod.tsx" => Some(ApiProvenance::Inferred),
            _ => None,
        };
        if let Some(provenance) = provenance {
            entrypoints.insert(TsEntrypoint {
                path: path.clone(),
                module_path: import_path(root, path),
                provenance,
                metadata_backed: false,
            });
        }
    }
    entrypoints.into_iter().collect()
}

fn collect_typescript_export_targets(value: &serde_json::Value, targets: &mut Vec<String>) {
    match value {
        serde_json::Value::String(target) => targets.push(target.clone()),
        serde_json::Value::Array(values) => {
            for value in values {
                collect_typescript_export_targets(value, targets);
            }
        }
        serde_json::Value::Object(values) => {
            for value in values.values() {
                collect_typescript_export_targets(value, targets);
            }
        }
        _ => {}
    }
}

fn resolve_typescript_entry_target(
    package_root: &Path,
    target: &str,
    modules: &BTreeMap<PathBuf, TsModule>,
) -> Option<PathBuf> {
    let target = target.trim_start_matches("./");
    let base = package_root.join(target);
    let mut possible = vec![base.clone()];
    if base.extension().is_none() {
        possible.extend([base.with_extension("ts"), base.with_extension("tsx")]);
    } else if matches!(
        base.extension().and_then(|value| value.to_str()),
        Some("js" | "mjs" | "cjs")
    ) {
        possible.extend([base.with_extension("ts"), base.with_extension("tsx")]);
    }
    possible
        .into_iter()
        .filter_map(|path| fs::canonicalize(path).ok())
        .find(|path| modules.contains_key(path))
}

fn resolve_typescript_source(
    current: &Path,
    source: &str,
    modules: &BTreeMap<PathBuf, TsModule>,
    diagnostics: &mut Vec<String>,
) -> Option<PathBuf> {
    if !source.starts_with('.') {
        diagnostics.push(format!(
            "unsupported non-relative TypeScript re-export {source:?} in {}",
            current.display()
        ));
        return None;
    }
    let parent = current.parent()?;
    let base = parent.join(source);
    let mut possible = vec![base.clone()];
    if base.extension().is_some_and(|extension| extension == "js") {
        possible.extend([base.with_extension("ts"), base.with_extension("tsx")]);
    } else if base.extension().is_none() {
        possible.extend([
            base.with_extension("ts"),
            base.with_extension("tsx"),
            base.join("mod.ts"),
            base.join("mod.tsx"),
            base.join("index.ts"),
            base.join("index.tsx"),
        ]);
    }
    let matches = possible
        .into_iter()
        .filter_map(|candidate| fs::canonicalize(candidate).ok())
        .filter(|candidate| modules.contains_key(candidate))
        .collect::<BTreeSet<_>>();
    if matches.len() != 1 {
        diagnostics.push(format!(
            "TypeScript re-export {source:?} in {} resolved to {} files",
            current.display(),
            matches.len()
        ));
        return None;
    }
    matches.into_iter().next()
}

fn import_path(root: &Path, path: &Path) -> String {
    format!(
        "./{}",
        relative_path(path.strip_prefix(root).unwrap_or(path))
    )
}

fn relative_path(path: &Path) -> String {
    path.components()
        .map(|component| component.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
}

fn surface_matches(candidate: &ApiCandidate, surface: ApiSurfaceFilter) -> bool {
    match surface {
        ApiSurfaceFilter::All => true,
        ApiSurfaceFilter::Public => candidate.visibility == ApiVisibility::Public,
        ApiSurfaceFilter::Private => {
            candidate.visibility != ApiVisibility::Public
                && candidate.visibility != ApiVisibility::Unknown
        }
        ApiSurfaceFilter::SourceExport => candidate.source_export == ApiStatus::Yes,
        ApiSurfaceFilter::PackageSurface => candidate.package_surface == ApiStatus::Yes,
    }
}

fn query_work(candidate: &ApiCandidate, query: &ApiQuery) -> usize {
    match query {
        ApiQuery::FuzzyName { name, .. } => candidate
            .name
            .chars()
            .count()
            .saturating_add(1)
            .saturating_mul(name.chars().count().saturating_add(1)),
        ApiQuery::Documentation { terms, .. } => candidate
            .signature
            .chars()
            .count()
            .saturating_mul(terms.len()),
        _ => 1,
    }
}

fn query_score(candidate: &ApiCandidate, query: &ApiQuery) -> Option<usize> {
    match query {
        ApiQuery::ExactName { name } => (candidate.name == *name).then_some(0),
        ApiQuery::PrefixName { name } => candidate
            .name
            .to_lowercase()
            .starts_with(&name.to_lowercase())
            .then_some(0),
        ApiQuery::SubstringName { name } => candidate
            .name
            .to_lowercase()
            .contains(&name.to_lowercase())
            .then_some(0),
        ApiQuery::FuzzyName { name, .. } => Some(levenshtein(
            &candidate.name.to_lowercase(),
            &name.to_lowercase(),
        )),
        ApiQuery::DeclarationKind { declaration_kind } => {
            (candidate.symbol_type == *declaration_kind).then_some(0)
        }
        ApiQuery::Documentation { terms, .. } => {
            let signature = candidate.signature.to_lowercase();
            terms
                .iter()
                .all(|term| signature.contains(&term.to_lowercase()))
                .then_some(0)
        }
    }
}

fn levenshtein(left: &str, right: &str) -> usize {
    let right = right.chars().collect::<Vec<_>>();
    let mut previous = (0..=right.len()).collect::<Vec<_>>();
    for (left_index, left_character) in left.chars().enumerate() {
        let mut current = vec![left_index + 1];
        for (right_index, right_character) in right.iter().enumerate() {
            current.push(
                (previous[right_index + 1] + 1)
                    .min(current[right_index] + 1)
                    .min(previous[right_index] + usize::from(left_character != *right_character)),
            );
        }
        previous = current;
    }
    previous[right.len()]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::outline::SymbolView;

    #[test]
    fn computes_stable_unicode_fuzzy_distance() {
        assert_eq!(levenshtein("cursor", "curser"), 1);
        assert_eq!(levenshtein("décode", "decode"), 1);
    }

    #[test]
    fn parses_typescript_export_forms() {
        assert_eq!(
            parse_typescript_export("export * from \"./leaf.ts\";").len(),
            1
        );
        assert_eq!(
            parse_typescript_export("export { source as publicName } from './leaf.ts';").len(),
            1
        );
        assert_eq!(
            parse_typescript_export("export * as utilities from './leaf.ts';").len(),
            1
        );
        let mixed =
            parse_typescript_import("import defaultValue, { source as local } from './leaf.ts';");
        assert_eq!(
            mixed.get("defaultValue"),
            Some(&("./leaf.ts".to_owned(), "default".to_owned()))
        );
        assert_eq!(
            mixed.get("local"),
            Some(&("./leaf.ts".to_owned(), "source".to_owned()))
        );
        assert_eq!(
            parse_typescript_import("import * as utilities from './leaf.ts';").get("utilities"),
            Some(&("./leaf.ts".to_owned(), "*".to_owned()))
        );
    }

    #[test]
    fn discovers_deno_package_surfaces_and_reuses_fingerprinted_locators() {
        let engine = OutlineEngine::new().expect("outline engine should initialize");
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/api-discovery");
        let budgets = RecursiveBudgets {
            max_files: 20,
            max_source_bytes: 1024 * 1024,
            max_depth: 8,
            max_elapsed_ms: 5_000,
        };
        let result = engine
            .discover_api(
                &root.to_string_lossy(),
                budgets,
                ApiQuery::ExactName {
                    name: "interpolateColor".to_owned(),
                },
                ApiSurfaceFilter::PackageSurface,
                10,
            )
            .expect("package discovery should complete");
        assert_eq!(result.candidates.len(), 1);
        let candidate = &result.candidates[0];
        assert_eq!(candidate.name, "interpolateColor");
        assert_eq!(
            candidate.caller_access,
            Some(ApiCallerAccess {
                module_path: "@tau/api-discovery-fixture".to_owned(),
                import_statement: "import { blendColor } from \"@tau/api-discovery-fixture\";"
                    .to_owned(),
                access_expression: "blendColor".to_owned(),
                form: ApiAccessForm::Direct,
            })
        );
        assert_eq!(
            candidate.re_export_chain,
            ["mod.ts", "barrel.ts", "leaf.ts"]
        );
        assert_eq!(candidate.package_surface, ApiStatus::Yes);
        assert_eq!(candidate.internal_only, ApiStatus::No);

        let documented = engine
            .symbol(
                std::slice::from_ref(&candidate.locator),
                SymbolView::SignatureWithDocs,
                0,
            )
            .expect("discovery locator should resolve through symbol");
        assert!(
            documented.blocks[0]
                .source
                .contains("Interpolates cursor colors")
        );
        assert!(!documented.blocks[0].source.contains("return"));

        for query in [
            ApiQuery::PrefixName {
                name: "interpolate".to_owned(),
            },
            ApiQuery::SubstringName {
                name: "Color".to_owned(),
            },
            ApiQuery::FuzzyName {
                name: "interpolatColor".to_owned(),
                max_candidates: 20,
                max_work: 10_000,
            },
            ApiQuery::DeclarationKind {
                declaration_kind: SymbolType::Function,
            },
            ApiQuery::Documentation {
                terms: vec!["cursor".to_owned(), "colors".to_owned()],
                max_candidates: 20,
                max_work: 100_000,
            },
        ] {
            let discovered = engine
                .discover_api(
                    &root.to_string_lossy(),
                    budgets,
                    query,
                    ApiSurfaceFilter::PackageSurface,
                    10,
                )
                .expect("bounded query should complete");
            assert!(
                discovered
                    .candidates
                    .iter()
                    .any(|candidate| candidate.name == "interpolateColor")
            );
        }

        let internal = engine
            .discover_api(
                &root.to_string_lossy(),
                budgets,
                ApiQuery::ExactName {
                    name: "sourceOnlyCursor".to_owned(),
                },
                ApiSurfaceFilter::SourceExport,
                10,
            )
            .expect("source-export discovery should complete");
        assert_eq!(internal.candidates[0].package_surface, ApiStatus::No);
        assert_eq!(internal.candidates[0].internal_only, ApiStatus::Yes);
    }

    #[test]
    fn exact_discovery_resolves_rust_module_surfaces_after_source_prefiltering() {
        let engine = OutlineEngine::new().expect("outline engine should initialize");
        let root = std::env::temp_dir().join(format!(
            "tau-ast-rust-discovery-prefilter-{}",
            std::process::id()
        ));
        fs::create_dir_all(root.join("src")).expect("Rust fixture should be writable");
        fs::write(
            root.join("Cargo.toml"),
            "[package]\nname = \"fixture-crate\"\nversion = \"0.1.0\"\n",
        )
        .expect("Rust manifest should be writable");
        fs::write(root.join("src/lib.rs"), "pub mod public;\n")
            .expect("Rust crate root should be writable");
        fs::write(
            root.join("src/public.rs"),
            "/// Public API.\npub fn public_api() {}\n",
        )
        .expect("Rust module should be writable");

        let result = engine
            .discover_api(
                &root.to_string_lossy(),
                RecursiveBudgets {
                    max_files: 10,
                    max_source_bytes: 1024 * 1024,
                    max_depth: 8,
                    max_elapsed_ms: 5_000,
                },
                ApiQuery::ExactName {
                    name: "public_api".to_owned(),
                },
                ApiSurfaceFilter::PackageSurface,
                10,
            )
            .expect("Rust package discovery should complete");

        assert_eq!(result.summary.files_scanned, 2);
        assert_eq!(result.summary.declarations_considered, 1);
        assert_eq!(result.candidates.len(), 1);
        assert_eq!(result.candidates[0].package_surface, ApiStatus::Yes);
        assert_eq!(
            result.candidates[0]
                .caller_access
                .as_ref()
                .map(|access| access.module_path.as_str()),
            Some("fixture_crate::public")
        );
        fs::remove_dir_all(root).expect("Rust fixture should be removable");
    }

    #[test]
    fn exact_discovery_keeps_synthesized_and_normalized_names() {
        let engine = OutlineEngine::new().expect("outline engine should initialize");
        let root = std::env::temp_dir().join(format!(
            "tau-ast-synthesized-discovery-names-{}",
            std::process::id()
        ));
        fs::create_dir_all(&root).expect("discovery fixture should be writable");
        fs::write(root.join("service.kt"), "class Service(value: String)\n")
            .expect("Kotlin fixture should be writable");
        fs::write(root.join("guide.md"), "Alpha\nBeta\n=====\n")
            .expect("Markdown fixture should be writable");
        let budgets = RecursiveBudgets {
            max_files: 10,
            max_source_bytes: 1024 * 1024,
            max_depth: 8,
            max_elapsed_ms: 5_000,
        };

        for name in ["constructor", "Alpha Beta"] {
            let result = engine
                .discover_api(
                    &root.to_string_lossy(),
                    budgets,
                    ApiQuery::ExactName {
                        name: name.to_owned(),
                    },
                    ApiSurfaceFilter::All,
                    10,
                )
                .expect("exact discovery should complete");
            assert!(
                result
                    .candidates
                    .iter()
                    .any(|candidate| candidate.name == name),
                "exact discovery omitted {name}"
            );
        }
        fs::remove_dir_all(root).expect("discovery fixture should be removable");
    }
}
