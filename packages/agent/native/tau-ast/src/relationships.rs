use crate::{
    language::OdinLanguage,
    outline::{
        LanguageId, LocatorKind, OutlineEngine, OutlineEntry, OutlineFileResult, OutlineRowKind,
        ParseCertainty, RecursiveBudgets, RecursiveOutlineEvent, SourceRange, SymbolType,
        decode_source_locator, encode_executable_scope_locator, encode_synthetic_scope_locator,
        source_fingerprint,
    },
    source::{certainty as parse_certainty, certainty_reason, source_range},
};
use ast_grep_core::{Doc, Node, tree_sitter::LanguageExt};
use ast_grep_language::SupportLang;
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    error::Error,
    fs,
    ops::Range,
    path::{Path, PathBuf},
};

const MAX_RESULTS: usize = 100;
const MAX_COMPETING_CANDIDATES: usize = 16;

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RelationshipOperation {
    References,
    Callers,
    Callees,
    Implementations,
    Tests,
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RelationshipKind {
    Reference,
    TypeUsage,
    Caller,
    Callee,
    Implementation,
    Override,
    ReExport,
    Test,
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RelationshipCertainty {
    Exact,
    Inferred,
    Ambiguous,
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum LocationClassification {
    Production,
    Test,
    Generated,
    ReExport,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditableScope {
    pub locator: String,
    pub language: LanguageId,
    pub kind: String,
    pub qualified_identity: String,
    pub range: SourceRange,
    pub body_range: Option<SourceRange>,
    pub source_fingerprint: String,
    pub certainty: ParseCertainty,
    pub certainty_reason: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Relationship {
    pub relative_path: String,
    pub language: LanguageId,
    pub range: SourceRange,
    pub relationship_kind: RelationshipKind,
    pub certainty: RelationshipCertainty,
    pub parse_certainty: ParseCertainty,
    pub certainty_reason: Option<String>,
    pub classification: LocationClassification,
    pub target_locator: String,
    pub target_path: String,
    pub candidate_locators: Vec<String>,
    pub candidate_paths: Vec<String>,
    pub competing_candidates_omitted: usize,
    pub actionable: bool,
    pub enclosing_scope: EditableScope,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelationshipSummary {
    pub files_scanned: usize,
    pub source_bytes: usize,
    pub parser_degraded_files: usize,
    pub relationships_found: usize,
    pub relationships_returned: usize,
    pub result_limit: usize,
    pub result_limit_reached: bool,
    pub ambiguous_relationships: usize,
    pub diagnostics: usize,
    pub file_limit_reached: bool,
    pub source_byte_limit_reached: bool,
    pub depth_limit_reached: bool,
    pub elapsed_limit_reached: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelationshipResult {
    pub path: String,
    pub operation: RelationshipOperation,
    pub target_name: String,
    pub target_locator: String,
    pub relationships: Vec<Relationship>,
    pub summary: RelationshipSummary,
}

struct IndexedFile {
    relative_path: String,
    outlined: OutlineFileResult,
    source: String,
}

#[derive(Clone)]
struct IndexedDeclaration {
    path: String,
    entry: OutlineEntry,
    locator: String,
}

#[derive(Clone)]
struct RawOccurrence {
    range: Range<usize>,
    call: bool,
    type_usage: bool,
    implementation: bool,
    shadowed: bool,
    callback_scope: Option<(Range<usize>, String)>,
    parse_certainty: ParseCertainty,
}

impl OutlineEngine {
    pub fn relationships(
        &self,
        path: &str,
        budgets: RecursiveBudgets,
        encoded_locator: &str,
        operation: RelationshipOperation,
        result_limit: usize,
    ) -> Result<RelationshipResult, Box<dyn Error>> {
        if result_limit == 0 || result_limit > MAX_RESULTS {
            return Err(
                format!("relationship resultLimit must be between 1 and {MAX_RESULTS}").into(),
            );
        }
        let root = fs::canonicalize(path)?;
        if !root.is_dir() {
            return Err(
                format!("relationship scope is not a directory: {}", root.display()).into(),
            );
        }
        let mut target = decode_source_locator(encoded_locator)?;
        if target.locator_kind != LocatorKind::Declaration {
            return Err("relationships require a declaration locator".into());
        }
        target.path = fs::canonicalize(&target.path)?
            .to_string_lossy()
            .into_owned();
        if !Path::new(&target.path).starts_with(&root) {
            return Err(
                "relationship declaration is outside the requested repository scope".into(),
            );
        }
        let target_source = fs::read(&target.path)?;
        if source_fingerprint(&target_source) != target.source_fingerprint {
            return Err(
                "source changed since the declaration locator was created; request a fresh locator"
                    .into(),
            );
        }
        let target_name = std::str::from_utf8(
            target_source
                .get(target.name_range.start_byte..target.name_range.end_byte)
                .ok_or("declaration locator name range is outside the source")?,
        )?
        .to_owned();

        let mut emitted = Vec::new();
        let mut recursive_diagnostics = 0;
        let traversal = self.outline_recursive(
            &root.to_string_lossy(),
            budgets,
            true,
            false,
            &[],
            None,
            &mut |event| {
                match event {
                    RecursiveOutlineEvent::File {
                        relative_path,
                        file,
                    } => {
                        if same_language_family(file.language, target.language) {
                            emitted.push((relative_path, file));
                        }
                    }
                    RecursiveOutlineEvent::Diagnostic(_) => recursive_diagnostics += 1,
                }
                Ok(())
            },
        )?;

        let mut diagnostics = recursive_diagnostics;
        let mut files = Vec::new();
        for (relative_path, outlined) in emitted {
            let bytes = match fs::read(&outlined.path) {
                Ok(bytes) => bytes,
                Err(_) => {
                    diagnostics += 1;
                    continue;
                }
            };
            if source_fingerprint(&bytes) != outlined.source_fingerprint {
                diagnostics += 1;
                continue;
            }
            let source = match String::from_utf8(bytes) {
                Ok(source) => source,
                Err(_) => {
                    diagnostics += 1;
                    continue;
                }
            };
            files.push(IndexedFile {
                relative_path,
                outlined,
                source,
            });
        }

        let declarations = index_declarations(&files);
        let mut declarations_by_name = BTreeMap::<String, Vec<IndexedDeclaration>>::new();
        for declaration in &declarations {
            declarations_by_name
                .entry(declaration.entry.name.clone())
                .or_default()
                .push(declaration.clone());
        }
        for candidates in declarations_by_name.values_mut() {
            candidates.sort_by(|left, right| {
                left.path.cmp(&right.path).then(
                    left.entry
                        .range
                        .start_byte
                        .cmp(&right.entry.range.start_byte),
                )
            });
        }

        let mut relationships = match operation {
            RelationshipOperation::Callees => {
                collect_callees(&files, &declarations_by_name, &target, encoded_locator)?
            }
            RelationshipOperation::Implementations => collect_implementations(
                &files,
                &declarations_by_name,
                &target,
                &target_name,
                encoded_locator,
            )?,
            operation => collect_target_occurrences(
                &files,
                declarations_by_name
                    .get(&target_name)
                    .map(Vec::as_slice)
                    .unwrap_or(&[]),
                &target,
                &target_name,
                encoded_locator,
                operation,
            )?,
        };
        relationships.sort_by(|left, right| {
            left.relative_path
                .cmp(&right.relative_path)
                .then(left.range.start_byte.cmp(&right.range.start_byte))
                .then(left.relationship_kind.cmp(&right.relationship_kind))
                .then(left.target_locator.cmp(&right.target_locator))
        });
        relationships.dedup_by(|left, right| {
            left.relative_path == right.relative_path
                && left.range.start_byte == right.range.start_byte
                && left.range.end_byte == right.range.end_byte
                && left.relationship_kind == right.relationship_kind
                && left.target_locator == right.target_locator
        });
        let relationships_found = relationships.len();
        let ambiguous_relationships = relationships
            .iter()
            .filter(|relationship| relationship.certainty == RelationshipCertainty::Ambiguous)
            .count();
        relationships.truncate(result_limit);
        let summary = RelationshipSummary {
            files_scanned: files.len(),
            source_bytes: traversal.total_byte_length,
            parser_degraded_files: traversal.parser_degraded_files,
            relationships_found,
            relationships_returned: relationships.len(),
            result_limit,
            result_limit_reached: relationships_found > relationships.len(),
            ambiguous_relationships,
            diagnostics,
            file_limit_reached: traversal.file_limit_reached,
            source_byte_limit_reached: traversal.source_byte_limit_reached,
            depth_limit_reached: traversal.depth_limit_reached,
            elapsed_limit_reached: traversal.elapsed_limit_reached,
        };
        Ok(RelationshipResult {
            path: root.to_string_lossy().into_owned(),
            operation,
            target_name,
            target_locator: encoded_locator.to_owned(),
            relationships,
            summary,
        })
    }
}

fn index_declarations(files: &[IndexedFile]) -> Vec<IndexedDeclaration> {
    let mut declarations = Vec::new();
    for file in files {
        for item in &file.outlined.items {
            if item.row_kind != OutlineRowKind::Declaration {
                continue;
            }
            push_declaration(file, &item.entry, &mut declarations);
            for member in &item.members {
                push_declaration(file, &member.entry, &mut declarations);
            }
        }
    }
    declarations
}

fn push_declaration(
    file: &IndexedFile,
    entry: &OutlineEntry,
    output: &mut Vec<IndexedDeclaration>,
) {
    let Some(locator) = &entry.locator else {
        return;
    };
    output.push(IndexedDeclaration {
        path: file.outlined.path.clone(),
        entry: entry.clone(),
        locator: locator.clone(),
    });
}

fn collect_target_occurrences(
    files: &[IndexedFile],
    candidates: &[IndexedDeclaration],
    target: &crate::outline::SourceLocator,
    target_name: &str,
    encoded_target: &str,
    operation: RelationshipOperation,
) -> Result<Vec<Relationship>, Box<dyn Error>> {
    let mut output = Vec::new();
    for file in files {
        let names = target_names_for_file(file, target, target_name);
        let occurrences = collect_occurrences(file, &names)?;
        for occurrence in occurrences {
            if is_declaration_name(file, &occurrence.range) {
                continue;
            }
            if occurrence.shadowed {
                continue;
            }
            let re_export = row_at(file, &occurrence.range) == Some(OutlineRowKind::Export);
            let classification = classify_location(file, &occurrence.range, re_export);
            let include = match operation {
                RelationshipOperation::References => true,
                RelationshipOperation::Callers => occurrence.call,
                RelationshipOperation::Tests => classification == LocationClassification::Test,
                _ => false,
            };
            if !include {
                continue;
            }
            let exact_binding = (file.outlined.path == target.path
                || resolves_typescript_binding(file, target, target_name))
                && matches!(
                    file.outlined.language,
                    LanguageId::TypeScript | LanguageId::Tsx
                );
            let (certainty, candidate_locators, candidate_paths, omitted) =
                relationship_certainty(candidates, exact_binding);
            let kind = match operation {
                RelationshipOperation::Tests => RelationshipKind::Test,
                _ if re_export => RelationshipKind::ReExport,
                _ if occurrence.call => RelationshipKind::Caller,
                _ if occurrence.type_usage => RelationshipKind::TypeUsage,
                _ => RelationshipKind::Reference,
            };
            output.push(make_relationship(
                file,
                occurrence,
                kind,
                certainty,
                classification,
                encoded_target.to_owned(),
                target.path.clone(),
                candidate_locators,
                candidate_paths,
                omitted,
            )?);
        }
    }
    Ok(output)
}

fn collect_callees(
    files: &[IndexedFile],
    declarations_by_name: &BTreeMap<String, Vec<IndexedDeclaration>>,
    target: &crate::outline::SourceLocator,
    encoded_target: &str,
) -> Result<Vec<Relationship>, Box<dyn Error>> {
    let Some(file) = files.iter().find(|file| file.outlined.path == target.path) else {
        return Ok(Vec::new());
    };
    let names = declarations_by_name
        .keys()
        .cloned()
        .collect::<BTreeSet<_>>();
    let selected = target.body_range.as_ref().unwrap_or(&target.range);
    let mut output = Vec::new();
    for occurrence in collect_occurrences(file, &names)? {
        if !occurrence.call
            || occurrence.range.start < selected.start_byte
            || occurrence.range.end > selected.end_byte
            || is_declaration_name(file, &occurrence.range)
            || occurrence.shadowed
        {
            continue;
        }
        let Some(name) = file.source.get(occurrence.range.clone()) else {
            continue;
        };
        let Some(candidates) = declarations_by_name.get(name) else {
            continue;
        };
        let exact = candidates.len() == 1 && candidates[0].path == file.outlined.path;
        let (certainty, candidate_locators, candidate_paths, omitted) =
            relationship_certainty(candidates, exact);
        let target_locator = candidates.first().map_or_else(
            || encoded_target.to_owned(),
            |candidate| candidate.locator.clone(),
        );
        let target_path = candidates
            .first()
            .map_or_else(|| target.path.clone(), |candidate| candidate.path.clone());
        output.push(make_relationship(
            file,
            occurrence,
            RelationshipKind::Callee,
            certainty,
            classify_location(file, &(selected.start_byte..selected.end_byte), false),
            target_locator,
            target_path,
            candidate_locators,
            candidate_paths,
            omitted,
        )?);
    }
    Ok(output)
}

fn collect_implementations(
    files: &[IndexedFile],
    declarations_by_name: &BTreeMap<String, Vec<IndexedDeclaration>>,
    target: &crate::outline::SourceLocator,
    target_name: &str,
    encoded_target: &str,
) -> Result<Vec<Relationship>, Box<dyn Error>> {
    if is_callable_symbol(&target.declaration_kind) {
        let candidates = declarations_by_name
            .get(target_name)
            .map(Vec::as_slice)
            .unwrap_or(&[]);
        let competing = candidates
            .iter()
            .filter(|candidate| {
                candidate.locator != encoded_target
                    && (candidate.entry.signature.contains("override")
                        || candidate.entry.signature.contains("@Override"))
            })
            .collect::<Vec<_>>();
        let ambiguous = competing.len() > 1;
        let mut output = Vec::new();
        for candidate in &competing {
            let Some(file) = files
                .iter()
                .find(|file| file.outlined.path == candidate.path)
            else {
                continue;
            };
            let occurrence = RawOccurrence {
                range: candidate.entry.name_range.start_byte..candidate.entry.name_range.end_byte,
                call: false,
                type_usage: false,
                implementation: true,
                shadowed: false,
                callback_scope: None,
                parse_certainty: candidate.entry.certainty,
            };
            let mut locators = competing
                .iter()
                .map(|item| item.locator.clone())
                .collect::<Vec<_>>();
            let mut paths = competing
                .iter()
                .map(|item| item.path.clone())
                .collect::<Vec<_>>();
            let omitted = locators.len().saturating_sub(MAX_COMPETING_CANDIDATES);
            locators.truncate(MAX_COMPETING_CANDIDATES);
            paths.truncate(MAX_COMPETING_CANDIDATES);
            output.push(make_relationship(
                file,
                occurrence,
                RelationshipKind::Override,
                if ambiguous {
                    RelationshipCertainty::Ambiguous
                } else {
                    RelationshipCertainty::Inferred
                },
                classify_location(
                    file,
                    &(candidate.entry.range.start_byte..candidate.entry.range.end_byte),
                    false,
                ),
                candidate.locator.clone(),
                candidate.path.clone(),
                locators,
                paths,
                omitted,
            )?);
        }
        return Ok(output);
    }

    let candidates = declarations_by_name
        .get(target_name)
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    let mut output = Vec::new();
    for file in files {
        for occurrence in collect_occurrences(file, &BTreeSet::from([target_name.to_owned()]))? {
            if !occurrence.implementation || is_declaration_name(file, &occurrence.range) {
                continue;
            }
            let (certainty, candidate_locators, candidate_paths, omitted) =
                relationship_certainty(candidates, true);
            output.push(make_relationship(
                file,
                occurrence,
                RelationshipKind::Implementation,
                certainty,
                classify_location(
                    file,
                    &(target.range.start_byte..target.range.end_byte),
                    false,
                ),
                encoded_target.to_owned(),
                target.path.clone(),
                candidate_locators,
                candidate_paths,
                omitted,
            )?);
        }
    }
    Ok(output)
}

#[allow(clippy::too_many_arguments)]
fn make_relationship(
    file: &IndexedFile,
    occurrence: RawOccurrence,
    kind: RelationshipKind,
    certainty: RelationshipCertainty,
    classification: LocationClassification,
    target_locator: String,
    target_path: String,
    candidate_locators: Vec<String>,
    candidate_paths: Vec<String>,
    omitted: usize,
) -> Result<Relationship, Box<dyn Error>> {
    let range = source_range(file.source.as_bytes(), occurrence.range.clone());
    let enclosing_scope = editable_scope(file, &occurrence)?;
    let reason = if certainty == RelationshipCertainty::Ambiguous {
        Some(
            "multiple declarations remain viable; inspect candidate locators before editing"
                .to_owned(),
        )
    } else {
        certainty_reason(occurrence.parse_certainty)
    };
    Ok(Relationship {
        relative_path: file.relative_path.clone(),
        language: file.outlined.language,
        range,
        relationship_kind: kind,
        certainty,
        parse_certainty: occurrence.parse_certainty,
        certainty_reason: reason,
        classification,
        target_locator,
        target_path,
        candidate_locators,
        candidate_paths,
        competing_candidates_omitted: omitted,
        actionable: certainty != RelationshipCertainty::Ambiguous,
        enclosing_scope,
    })
}

fn editable_scope(
    file: &IndexedFile,
    occurrence: &RawOccurrence,
) -> Result<EditableScope, Box<dyn Error>> {
    if let Some((bytes, kind)) = &occurrence.callback_scope {
        let identity = format!("<callback:{kind}:{}>", bytes.start);
        let range = source_range(file.source.as_bytes(), bytes.clone());
        let locator = encode_synthetic_scope_locator(
            &file.outlined.path,
            file.outlined.language,
            &file.outlined.source_fingerprint,
            &identity,
            kind,
            range.clone(),
            Some(range.clone()),
            occurrence.parse_certainty,
            file.source.get(bytes.clone()).unwrap_or(""),
        )?;
        return Ok(EditableScope {
            locator,
            language: file.outlined.language,
            kind: kind.clone(),
            qualified_identity: identity,
            range: range.clone(),
            body_range: Some(range),
            source_fingerprint: file.outlined.source_fingerprint.clone(),
            certainty: occurrence.parse_certainty,
            certainty_reason: certainty_reason(occurrence.parse_certainty),
        });
    }
    let entry = file
        .outlined
        .items
        .iter()
        .filter(|item| item.row_kind == OutlineRowKind::Declaration)
        .flat_map(|item| {
            std::iter::once(&item.entry).chain(item.members.iter().map(|member| &member.entry))
        })
        .filter(|entry| {
            entry.range.start_byte <= occurrence.range.start
                && entry.range.end_byte >= occurrence.range.end
                && (entry.body_range.is_some() || entry.symbol_type == SymbolType::Heading)
        })
        .min_by_key(|entry| entry.range.end_byte - entry.range.start_byte);
    if let Some(entry) = entry {
        return Ok(EditableScope {
            locator: encode_executable_scope_locator(
                entry,
                &file.outlined.path,
                file.outlined.language,
                &file.outlined.source_fingerprint,
            )?,
            language: file.outlined.language,
            kind: entry.ast_kind.clone(),
            qualified_identity: entry.qualified_name.clone(),
            range: entry.range.clone(),
            body_range: entry.body_range.clone(),
            source_fingerprint: file.outlined.source_fingerprint.clone(),
            certainty: entry.certainty,
            certainty_reason: entry.certainty_reason.clone(),
        });
    }
    let (bytes, kind, identity) = (
        0..file.source.len(),
        "topLevelExecutableRegion".to_owned(),
        "<top-level>".to_owned(),
    );
    let range = source_range(file.source.as_bytes(), bytes.clone());
    let locator = encode_synthetic_scope_locator(
        &file.outlined.path,
        file.outlined.language,
        &file.outlined.source_fingerprint,
        &identity,
        &kind,
        range.clone(),
        Some(range.clone()),
        occurrence.parse_certainty,
        file.source.get(bytes).unwrap_or(""),
    )?;
    Ok(EditableScope {
        locator,
        language: file.outlined.language,
        kind,
        qualified_identity: identity,
        range: range.clone(),
        body_range: Some(range),
        source_fingerprint: file.outlined.source_fingerprint.clone(),
        certainty: occurrence.parse_certainty,
        certainty_reason: certainty_reason(occurrence.parse_certainty),
    })
}

fn collect_occurrences(
    file: &IndexedFile,
    names: &BTreeSet<String>,
) -> Result<Vec<RawOccurrence>, Box<dyn Error>> {
    if file.outlined.language == LanguageId::Markdown {
        return Ok(text_occurrences(file, names));
    }
    let occurrences = match file.outlined.language {
        LanguageId::Odin => {
            let grep = OdinLanguage::Odin.ast_grep(&file.source);
            collect_root_occurrences(grep.root(), &file.source, names)
        }
        language => {
            let support = match language {
                LanguageId::TypeScript => SupportLang::TypeScript,
                LanguageId::Tsx => SupportLang::Tsx,
                LanguageId::Go => SupportLang::Go,
                LanguageId::Rust => SupportLang::Rust,
                LanguageId::CSharp => SupportLang::CSharp,
                LanguageId::Java => SupportLang::Java,
                LanguageId::Kotlin => SupportLang::Kotlin,
                LanguageId::Swift => SupportLang::Swift,
                LanguageId::Markdown | LanguageId::Odin => unreachable!(),
            };
            let grep = support.ast_grep(&file.source);
            collect_root_occurrences(grep.root(), &file.source, names)
        }
    };
    Ok(occurrences)
}

fn collect_root_occurrences<D: Doc>(
    root: Node<D>,
    source: &str,
    names: &BTreeSet<String>,
) -> Vec<RawOccurrence> {
    let recovery = root
        .dfs()
        .filter(|node| node.is_error() || node.is_missing())
        .map(|node| node.range())
        .collect::<Vec<_>>();
    let mut output = Vec::new();
    for node in root.dfs() {
        let kind = node.kind().into_owned();
        if !is_identifier_kind(&kind) {
            continue;
        }
        let bytes = node.range();
        let Some(text) = source.get(bytes.clone()) else {
            continue;
        };
        if !names.contains(text) {
            continue;
        }
        let ancestors = node.ancestors().take(8).collect::<Vec<_>>();
        let callback_scope = ancestors
            .iter()
            .find(|ancestor| is_callback_kind(ancestor.kind().as_ref()))
            .map(|ancestor| (ancestor.range(), ancestor.kind().into_owned()));
        let ownership = callback_scope
            .as_ref()
            .map_or_else(|| bytes.clone(), |(range, _)| range.clone());
        output.push(RawOccurrence {
            range: bytes.clone(),
            call: ancestors
                .iter()
                .take(3)
                .any(|ancestor| is_call_kind(ancestor.kind().as_ref())),
            type_usage: ancestors
                .iter()
                .take(3)
                .any(|ancestor| is_type_kind(ancestor.kind().as_ref())),
            implementation: ancestors
                .iter()
                .take(5)
                .any(|ancestor| is_implementation_kind(ancestor.kind().as_ref())),
            shadowed: binding_shadows(&ancestors, source, text, bytes.start),
            callback_scope,
            parse_certainty: parse_certainty(&recovery, &bytes, &ownership),
        });
    }
    output
}

fn text_occurrences(file: &IndexedFile, names: &BTreeSet<String>) -> Vec<RawOccurrence> {
    let mut output = Vec::new();
    for name in names {
        for (start, _) in file.source.match_indices(name) {
            let end = start + name.len();
            if is_word_boundary(&file.source, start, end) {
                output.push(RawOccurrence {
                    range: start..end,
                    call: false,
                    type_usage: false,
                    implementation: false,
                    shadowed: false,
                    callback_scope: None,
                    parse_certainty: ParseCertainty::Certain,
                });
            }
        }
    }
    output
}

fn relationship_certainty(
    candidates: &[IndexedDeclaration],
    exact_binding: bool,
) -> (RelationshipCertainty, Vec<String>, Vec<String>, usize) {
    let certainty = if candidates.len() > 1 && !exact_binding {
        RelationshipCertainty::Ambiguous
    } else if exact_binding {
        RelationshipCertainty::Exact
    } else {
        RelationshipCertainty::Inferred
    };
    let mut locators = candidates
        .iter()
        .map(|candidate| candidate.locator.clone())
        .collect::<Vec<_>>();
    let mut paths = candidates
        .iter()
        .map(|candidate| candidate.path.clone())
        .collect::<Vec<_>>();
    let omitted = locators.len().saturating_sub(MAX_COMPETING_CANDIDATES);
    locators.truncate(MAX_COMPETING_CANDIDATES);
    paths.truncate(MAX_COMPETING_CANDIDATES);
    (certainty, locators, paths, omitted)
}

fn target_names_for_file(
    file: &IndexedFile,
    target: &crate::outline::SourceLocator,
    target_name: &str,
) -> BTreeSet<String> {
    let mut names = BTreeSet::from([target_name.to_owned()]);
    if !matches!(
        file.outlined.language,
        LanguageId::TypeScript | LanguageId::Tsx
    ) {
        return names;
    }
    for item in &file.outlined.items {
        if item.row_kind != OutlineRowKind::Import {
            continue;
        }
        let Some(source) = quoted_module(&item.entry.signature) else {
            continue;
        };
        if !module_resolves_to(file, source, &target.path) {
            continue;
        }
        if let Some(open) = item.entry.signature.find('{')
            && let Some(close) = item.entry.signature[open + 1..].find('}')
        {
            for binding in item.entry.signature[open + 1..open + 1 + close].split(',') {
                let words = binding.split_whitespace().collect::<Vec<_>>();
                if words.first().copied() == Some(target_name) {
                    names.insert(words.get(2).copied().unwrap_or(target_name).to_owned());
                }
            }
        }
    }
    names
}

fn resolves_typescript_binding(
    file: &IndexedFile,
    target: &crate::outline::SourceLocator,
    target_name: &str,
) -> bool {
    matches!(
        file.outlined.language,
        LanguageId::TypeScript | LanguageId::Tsx
    ) && file.outlined.items.iter().any(|item| {
        matches!(
            item.row_kind,
            OutlineRowKind::Import | OutlineRowKind::Export
        ) && item.entry.signature.contains(target_name)
            && quoted_module(&item.entry.signature)
                .is_some_and(|source| module_resolves_to(file, source, &target.path))
    })
}

fn quoted_module(signature: &str) -> Option<&str> {
    let quote = if signature.rfind('\'')? > signature.rfind('"').unwrap_or(0) {
        '\''
    } else {
        '"'
    };
    let end = signature.rfind(quote)?;
    let start = signature[..end].rfind(quote)?;
    Some(&signature[start + 1..end])
}

fn module_resolves_to(file: &IndexedFile, source: &str, target: &str) -> bool {
    if !source.starts_with('.') {
        return false;
    }
    let base = Path::new(&file.outlined.path)
        .parent()
        .unwrap_or_else(|| Path::new("."));
    let path = base.join(source);
    let mut candidates = vec![path.clone()];
    for extension in ["ts", "tsx"] {
        candidates.push(path.with_extension(extension));
        candidates.push(path.join(format!("index.{extension}")));
    }
    candidates.into_iter().any(|candidate| {
        fs::canonicalize(candidate)
            .ok()
            .is_some_and(|candidate| candidate == PathBuf::from(target))
    })
}

fn row_at(file: &IndexedFile, bytes: &Range<usize>) -> Option<OutlineRowKind> {
    file.outlined
        .items
        .iter()
        .filter(|item| {
            item.entry.range.start_byte <= bytes.start && item.entry.range.end_byte >= bytes.end
        })
        .min_by_key(|item| item.entry.range.end_byte - item.entry.range.start_byte)
        .map(|item| item.row_kind)
}

fn is_declaration_name(file: &IndexedFile, bytes: &Range<usize>) -> bool {
    file.outlined.items.iter().any(|item| {
        item.row_kind == OutlineRowKind::Declaration
            && (same_bytes(&item.entry.name_range, bytes)
                || item
                    .members
                    .iter()
                    .any(|member| same_bytes(&member.entry.name_range, bytes)))
    })
}

fn same_bytes(range: &SourceRange, bytes: &Range<usize>) -> bool {
    range.start_byte == bytes.start && range.end_byte == bytes.end
}

fn classify_location(
    file: &IndexedFile,
    bytes: &Range<usize>,
    re_export: bool,
) -> LocationClassification {
    let path = file.relative_path.to_ascii_lowercase();
    if path
        .split('/')
        .any(|part| matches!(part, "generated" | "gen" | "dist" | "build" | "target"))
        || path.contains(".generated.")
        || path.ends_with(".g.cs")
        || path.ends_with(".designer.cs")
    {
        return LocationClassification::Generated;
    }
    if re_export {
        return LocationClassification::ReExport;
    }
    let file_name = path.rsplit('/').next().unwrap_or(&path);
    let test_path = path
        .split('/')
        .any(|part| matches!(part, "test" | "tests" | "__tests__"))
        || file_name.contains(".test.")
        || file_name.contains(".spec.")
        || file_name.ends_with("_test.go")
        || file_name.ends_with("_test.odin");
    let test_scope = file.outlined.items.iter().any(|item| {
        item.entry.range.start_byte <= bytes.start
            && item.entry.range.end_byte >= bytes.end
            && (item.entry.signature.contains("cfg(test)")
                || item.entry.signature.contains("#[test]")
                || item.entry.signature.contains("@Test")
                || item.entry.signature.contains("[Test]")
                || item.entry.signature.contains("[Fact]")
                || item.entry.qualified_name.contains(".tests"))
    });
    if test_path || test_scope {
        LocationClassification::Test
    } else {
        LocationClassification::Production
    }
}

fn same_language_family(left: LanguageId, right: LanguageId) -> bool {
    left == right
        || matches!(
            (left, right),
            (LanguageId::TypeScript, LanguageId::Tsx) | (LanguageId::Tsx, LanguageId::TypeScript)
        )
}

fn is_callable_symbol(kind: &str) -> bool {
    kind.contains("method")
        || kind.contains("function")
        || kind.contains("procedure")
        || kind.contains("constructor")
}

fn is_identifier_kind(kind: &str) -> bool {
    kind == "identifier"
        || kind.ends_with("_identifier")
        || matches!(
            kind,
            "simple_identifier" | "type_identifier" | "field_identifier" | "property_identifier"
        )
}

fn is_call_kind(kind: &str) -> bool {
    kind.contains("call")
        || kind.contains("invocation")
        || matches!(
            kind,
            "new_expression" | "macro_invocation" | "procedure_call"
        )
}

fn is_type_kind(kind: &str) -> bool {
    kind.contains("type")
        || matches!(
            kind,
            "class_heritage" | "base_list" | "superclass" | "trait_bounds"
        )
}

fn is_implementation_kind(kind: &str) -> bool {
    kind.contains("heritage")
        || kind.contains("superclass")
        || kind.contains("delegation_specifier")
        || kind.contains("inheritance")
        || matches!(
            kind,
            "base_list"
                | "super_interfaces"
                | "trait_bounds"
                | "impl_item"
                | "protocol_composition_type"
        )
}

fn is_callback_kind(kind: &str) -> bool {
    matches!(
        kind,
        "arrow_function"
            | "anonymous_function"
            | "anonymous_method_expression"
            | "closure_expression"
            | "function_expression"
            | "function_literal"
            | "lambda_expression"
            | "lambda_literal"
            | "proc_literal"
    )
}

fn binding_shadows<D: Doc>(
    ancestors: &[Node<D>],
    source: &str,
    name: &str,
    occurrence_start: usize,
) -> bool {
    let callable = ancestors.iter().find(|ancestor| {
        let kind = ancestor.kind();
        is_callback_kind(kind.as_ref())
            || kind.contains("function")
            || kind.contains("method")
            || kind.contains("constructor")
            || kind.contains("procedure")
    });
    let scope_start = callable.map_or(0, |scope| scope.range().start);
    let Some(prefix) = source.get(scope_start..occurrence_start) else {
        return true;
    };
    if let Some(scope) = callable
        && let Some(scope_source) = source.get(scope.range())
        && let Some(open) = scope_source.find('(')
        && let Some(close) = scope_source[open + 1..].find(')')
        && scope_source[open + 1..open + 1 + close]
            .split(',')
            .any(|parameter| parameter_binding(parameter, name))
    {
        return true;
    }
    ["const ", "let ", "var "].iter().any(|keyword| {
        prefix.match_indices(keyword).any(|(index, _)| {
            let start = index + keyword.len();
            prefix
                .get(start..start + name.len())
                .is_some_and(|candidate| candidate == name)
                && prefix[start + name.len()..]
                    .chars()
                    .next()
                    .is_none_or(|character| !character.is_alphanumeric() && character != '_')
        })
    }) || prefix.match_indices(name).any(|(index, _)| {
        prefix[index + name.len()..].trim_start().starts_with(":=")
            && prefix[..index]
                .chars()
                .next_back()
                .is_none_or(|character| !character.is_alphanumeric() && character != '_')
    })
}

fn parameter_binding(parameter: &str, name: &str) -> bool {
    let before_type = parameter
        .split([':', '='])
        .next()
        .unwrap_or(parameter)
        .trim()
        .trim_start_matches("...")
        .trim_end_matches('?')
        .trim();
    before_type == name
        || before_type
            .split_whitespace()
            .next_back()
            .is_some_and(|candidate| candidate == name)
}

fn is_word_boundary(source: &str, start: usize, end: usize) -> bool {
    let before = source[..start].chars().next_back();
    let after = source[end..].chars().next();
    before.is_none_or(|character| !character.is_alphanumeric() && character != '_')
        && after.is_none_or(|character| !character.is_alphanumeric() && character != '_')
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::outline::{OutlineTarget, SymbolView};

    fn budgets() -> RecursiveBudgets {
        RecursiveBudgets {
            max_files: 100,
            max_source_bytes: 1024 * 1024,
            max_depth: 8,
            max_elapsed_ms: 5_000,
        }
    }

    #[test]
    fn resolves_typescript_callers_tests_and_editable_scopes() {
        let directory = std::env::temp_dir().join(format!(
            "tau-ast-relationships-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        fs::create_dir_all(&directory).expect("relationship fixture directory");
        let target_path = directory.join("target.ts");
        fs::write(
            &target_path,
            "export function target(value: number) { return value + 1; }\n",
        )
        .expect("target fixture");
        fs::write(
            directory.join("caller.ts"),
            "import { target } from './target.ts';\nexport function caller() { return target(1); }\nexport function shadow(target: (value: number) => number) { return target(1); }\n",
        )
        .expect("caller fixture");
        fs::write(
            directory.join("target.test.ts"),
            "import { target } from './target.ts';\ntest('target', () => target(2));\n",
        )
        .expect("test fixture");

        let engine = OutlineEngine::new().expect("engine");
        let outlined = engine
            .outline(
                OutlineTarget::File {
                    path: target_path.to_string_lossy().into_owned(),
                    language: LanguageId::TypeScript,
                },
                true,
                false,
                &[],
            )
            .expect("target outline");
        let locator = outlined.files[0].items[0]
            .entry
            .locator
            .clone()
            .expect("target locator");
        let callers = engine
            .relationships(
                &directory.to_string_lossy(),
                budgets(),
                &locator,
                RelationshipOperation::Callers,
                10,
            )
            .expect("callers");
        let caller = callers
            .relationships
            .iter()
            .find(|relationship| relationship.relative_path == "caller.ts")
            .expect("direct caller");
        assert_eq!(caller.certainty, RelationshipCertainty::Exact);
        assert_eq!(caller.classification, LocationClassification::Production);
        let selected = engine
            .symbol(
                &[caller.enclosing_scope.locator.clone()],
                SymbolView::Declaration,
                0,
            )
            .expect("editable caller scope");
        assert!(selected.blocks[0].source.contains("function caller"));
        assert!(!callers.relationships.iter().any(|relationship| {
            relationship.relative_path == "caller.ts"
                && relationship.enclosing_scope.qualified_identity == "shadow"
        }));

        let tests = engine
            .relationships(
                &directory.to_string_lossy(),
                budgets(),
                &locator,
                RelationshipOperation::Tests,
                10,
            )
            .expect("tests");
        assert!(tests.relationships.iter().any(|relationship| {
            relationship.relative_path == "target.test.ts"
                && relationship.classification == LocationClassification::Test
        }));
        fs::remove_dir_all(directory).expect("remove relationship fixture");
    }
}
