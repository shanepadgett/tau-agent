use crate::{
    outline::{
        LanguageId, LocatorKind, OutlineEngine, OutlineEntry, OutlineFileResult, OutlineRowKind,
        ParseCertainty, RecursiveBudgets, SourceLocator, SourceRange, SymbolType,
        decode_source_locator, matching_entry, source_fingerprint,
    },
    relationships::{RelationshipCertainty, RelationshipResult},
    source::source_range,
};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, error::Error, fs, ops::Range, path::Path};

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum InsertPosition {
    Before,
    After,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum RenameScope {
    File,
    Repository { path: String },
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum EditOperation {
    ReplaceDeclaration {
        source: String,
    },
    ReplaceBody {
        body: String,
    },
    InsertDeclaration {
        position: InsertPosition,
        source: String,
    },
    RenameDeclaration {
        #[serde(rename = "newName")]
        new_name: String,
        scope: RenameScope,
        #[serde(rename = "includeInferred")]
        include_inferred: bool,
    },
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlannedEdit {
    pub range: SourceRange,
    pub replacement: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditFilePlan {
    pub path: String,
    pub expected_fingerprint: String,
    pub source: String,
    pub edits: Vec<PlannedEdit>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FreshLocator {
    pub locator: String,
    pub path: String,
    pub name: String,
    pub source_fingerprint: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkippedImpact {
    pub path: String,
    pub range: SourceRange,
    pub reason: &'static str,
    pub candidate_locators: Vec<String>,
    pub candidate_paths: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditPlanResult {
    pub files: Vec<EditFilePlan>,
    pub skipped_impacts: Vec<SkippedImpact>,
    pub fresh_locators: Vec<FreshLocator>,
}

#[derive(Clone)]
struct ByteEdit {
    range: Range<usize>,
    replacement: String,
}

#[derive(Clone)]
struct ParentIdentity {
    qualified_name: String,
    ast_kind: String,
    name_start: usize,
}

impl OutlineEngine {
    pub fn plan_edit(
        &self,
        encoded_locator: &str,
        operation: EditOperation,
        budgets: RecursiveBudgets,
    ) -> Result<EditPlanResult, Box<dyn Error>> {
        let mut target = decode_source_locator(encoded_locator)?;
        if target.locator_kind != LocatorKind::Declaration {
            return Err("locator edits require a declaration locator".into());
        }
        if target.language == LanguageId::Markdown
            && !matches!(
                &operation,
                EditOperation::ReplaceDeclaration { .. } | EditOperation::ReplaceBody { .. }
            )
        {
            return Err(
                "only declaration and body replacement are available for Markdown headings".into(),
            );
        }
        if target.certainty != ParseCertainty::Certain {
            return Err(
                "locator edits require a declaration with certain parse recovery status".into(),
            );
        }
        target.path = fs::canonicalize(&target.path)?
            .to_string_lossy()
            .into_owned();
        let source_bytes = fs::read(&target.path)?;
        if source_fingerprint(&source_bytes) != target.source_fingerprint {
            return Err(
                "source changed since the declaration locator was created; request a fresh locator"
                    .into(),
            );
        }
        let source = String::from_utf8(source_bytes)?;
        validate_range(&source, &target.range)?;
        validate_range(&source, &target.name_range)?;
        let current = self.outline_source(
            Path::new(&target.path),
            target.language,
            source.as_bytes().to_vec(),
            true,
            false,
            &[],
        )?;
        if matching_entry(&current, &target).is_none() {
            return Err("declaration locator no longer identifies the current syntax tree".into());
        }
        let parent = parent_identity(&current, &target);
        let current_siblings = immediate_declarations(&current, parent.as_ref())?;

        match operation {
            EditOperation::ReplaceDeclaration {
                source: replacement,
            } => {
                if target.language == LanguageId::Markdown {
                    return plan_markdown_section_replacement(
                        self,
                        &target,
                        source,
                        replacement,
                        &current,
                    );
                }
                let edit = ByteEdit {
                    range: target.range.start_byte..target.range.end_byte,
                    replacement,
                };
                let candidate = apply_edits(&source, std::slice::from_ref(&edit))?;
                let reparsed = parse_candidate(self, &target, &candidate, &current)?;
                let candidate_siblings = immediate_declarations(&reparsed, parent.as_ref())?;
                if candidate_siblings.len() != current_siblings.len() {
                    return Err("replace_declaration source must parse as exactly one declaration in the current parent container".into());
                }
                let fresh = candidate_siblings
                    .into_iter()
                    .filter(|entry| {
                        entry.certainty == ParseCertainty::Certain
                            && entry.range.start_byte < edit.range.start + edit.replacement.len()
                            && entry.range.end_byte > edit.range.start
                    })
                    .collect::<Vec<_>>();
                if fresh.len() != 1 {
                    return Err("replace_declaration source must produce one certain declaration in the current parent container".into());
                }
                finish_single_file(&target, source, candidate, vec![edit], fresh)
            }
            EditOperation::ReplaceBody { body } => {
                if target.language == LanguageId::Markdown {
                    return plan_markdown_body_replacement(self, &target, source, body, &current);
                }
                let body_range = target
                    .body_range
                    .clone()
                    .filter(|range| range.end_byte > range.start_byte)
                    .ok_or("replace_body requires a reliable non-empty body range")?;
                validate_range(&source, &body_range)?;
                let edit = ByteEdit {
                    range: body_range.start_byte..body_range.end_byte,
                    replacement: body,
                };
                let candidate = apply_edits(&source, std::slice::from_ref(&edit))?;
                let reparsed = parse_candidate(self, &target, &candidate, &current)?;
                let fresh = entries(&reparsed)
                    .find(|entry| {
                        entry.certainty == ParseCertainty::Certain
                            && entry.ast_kind == target.declaration_kind
                            && entry.name_range.start_byte == target.name_range.start_byte
                    })
                    .ok_or("replacement body no longer belongs to the selected declaration")?;
                finish_single_file(&target, source, candidate, vec![edit], vec![fresh])
            }
            EditOperation::InsertDeclaration {
                position,
                source: insertion,
            } => {
                let newline = if source.contains("\r\n") {
                    "\r\n"
                } else {
                    "\n"
                };
                let (byte, replacement) = match position {
                    InsertPosition::Before => (
                        target.range.start_byte,
                        format!("{}{newline}", insertion.trim_end_matches(['\r', '\n'])),
                    ),
                    InsertPosition::After => (
                        target.range.end_byte,
                        format!("{newline}{}", insertion.trim_start_matches(['\r', '\n'])),
                    ),
                };
                let edit = ByteEdit {
                    range: byte..byte,
                    replacement,
                };
                let candidate = apply_edits(&source, std::slice::from_ref(&edit))?;
                let reparsed = parse_candidate(self, &target, &candidate, &current)?;
                let candidate_siblings = immediate_declarations(&reparsed, parent.as_ref())?;
                if candidate_siblings.len() != current_siblings.len() + 1 {
                    return Err("insert_declaration source must parse as exactly one declaration in the selected parent container".into());
                }
                let inserted = byte..byte + edit.replacement.len();
                let fresh = candidate_siblings
                    .into_iter()
                    .filter(|entry| {
                        entry.certainty == ParseCertainty::Certain
                            && entry.range.start_byte < inserted.end
                            && entry.range.end_byte > inserted.start
                    })
                    .collect::<Vec<_>>();
                if fresh.len() != 1 {
                    return Err("insert_declaration source must produce one certain declaration in the selected parent container".into());
                }
                finish_single_file(&target, source, candidate, vec![edit], fresh)
            }
            EditOperation::RenameDeclaration {
                new_name,
                scope,
                include_inferred,
            } => self.plan_rename(
                encoded_locator,
                &target,
                source,
                &new_name,
                scope,
                include_inferred,
                budgets,
            ),
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn plan_rename(
        &self,
        encoded_locator: &str,
        target: &SourceLocator,
        target_source: String,
        new_name: &str,
        scope: RenameScope,
        include_inferred: bool,
        budgets: RecursiveBudgets,
    ) -> Result<EditPlanResult, Box<dyn Error>> {
        if new_name.is_empty()
            || new_name.chars().any(char::is_whitespace)
            || new_name.contains(['.', ':', '/', '\\', '(', ')', '{', '}', '[', ']', ';', ','])
        {
            return Err("newName must be one identifier for the target language".into());
        }
        let old_name = target_source
            .get(target.name_range.start_byte..target.name_range.end_byte)
            .ok_or("declaration locator name range is outside the source")?;
        if old_name == new_name {
            return Err("newName must differ from the current declaration name".into());
        }
        let (root, repository_scope) = match scope {
            RenameScope::File => (
                Path::new(&target.path)
                    .parent()
                    .ok_or("declaration path has no parent directory")?
                    .to_path_buf(),
                false,
            ),
            RenameScope::Repository { path } => (fs::canonicalize(path)?, true),
        };
        if !Path::new(&target.path).starts_with(&root) {
            return Err("rename declaration is outside the requested repository scope".into());
        }
        let relationships = if repository_scope {
            self.relationships_for_edit(&root.to_string_lossy(), budgets, encoded_locator)?
        } else {
            self.relationships_for_file_edit(encoded_locator)?
        };
        if repository_scope {
            validate_complete_repository_scope(&relationships)?;
        }

        let mut edits = BTreeMap::<String, Vec<ByteEdit>>::new();
        edits
            .entry(target.path.clone())
            .or_default()
            .push(ByteEdit {
                range: target.name_range.start_byte..target.name_range.end_byte,
                replacement: new_name.to_owned(),
            });
        let mut fingerprints =
            BTreeMap::from([(target.path.clone(), target.source_fingerprint.clone())]);
        let mut skipped_impacts = Vec::new();
        for relationship in relationships.relationships {
            let path = fs::canonicalize(root.join(&relationship.relative_path))?
                .to_string_lossy()
                .into_owned();
            if !repository_scope && path != target.path {
                continue;
            }
            let reason = if relationship.certainty == RelationshipCertainty::Ambiguous {
                Some("ambiguous")
            } else if relationship.parse_certainty != ParseCertainty::Certain {
                Some("uncertainParse")
            } else if relationship.certainty == RelationshipCertainty::Inferred && !include_inferred
            {
                Some("inferredNotApproved")
            } else {
                None
            };
            if let Some(reason) = reason {
                skipped_impacts.push(SkippedImpact {
                    path,
                    range: relationship.range,
                    reason,
                    candidate_locators: relationship.candidate_locators,
                    candidate_paths: relationship.candidate_paths,
                });
                continue;
            }
            if path == target.path && relationship.source_fingerprint != target.source_fingerprint {
                return Err(
                    "source changed while planning rename references in the target file".into(),
                );
            }
            fingerprints
                .entry(path.clone())
                .or_insert(relationship.source_fingerprint.clone());
            edits.entry(path).or_default().push(ByteEdit {
                range: relationship.range.start_byte..relationship.range.end_byte,
                replacement: new_name.to_owned(),
            });
        }

        let mut files = Vec::new();
        let mut target_reparsed = None;
        for (path, mut path_edits) in edits {
            path_edits.sort_by_key(|edit| (edit.range.start, edit.range.end));
            path_edits.dedup_by(|left, right| left.range == right.range);
            if path_edits
                .windows(2)
                .any(|pair| pair[0].range.end > pair[1].range.start)
            {
                return Err(format!("rename produced overlapping edits for {path}").into());
            }
            let bytes = fs::read(&path)?;
            let expected = fingerprints
                .get(&path)
                .ok_or("rename omitted an expected source fingerprint")?;
            if source_fingerprint(&bytes) != *expected {
                return Err(
                    format!("source changed while planning repository rename: {path}").into(),
                );
            }
            let source = String::from_utf8(bytes)?;
            for edit in &path_edits {
                source
                    .get(edit.range.clone())
                    .ok_or("rename reference range is outside the source or splits UTF-8")?;
            }
            let candidate = apply_edits(&source, &path_edits)?;
            let language = crate::outline::language_for_path(Path::new(&path))
                .ok_or("rename reached an unsupported source file")?;
            let baseline = self.outline_source(
                Path::new(&path),
                language,
                source.as_bytes().to_vec(),
                true,
                false,
                &[],
            )?;
            let reparsed = self.outline_source(
                Path::new(&path),
                language,
                candidate.as_bytes().to_vec(),
                true,
                false,
                &[],
            )?;
            ensure_no_new_recovery(&reparsed, &baseline)?;
            if path == target.path {
                target_reparsed = Some((
                    reparsed,
                    transformed_offset(target.name_range.start_byte, &path_edits),
                ));
            }
            files.push(EditFilePlan {
                path,
                expected_fingerprint: expected.clone(),
                source: candidate,
                edits: planned_edits(&source, path_edits),
            });
        }
        files.sort_by(|left, right| left.path.cmp(&right.path));
        let (target_reparsed, target_name_start) =
            target_reparsed.ok_or("rename did not reparse the target file")?;
        let fresh = entries(&target_reparsed)
            .find(|entry| {
                entry.certainty == ParseCertainty::Certain
                    && entry.name == new_name
                    && entry.name_range.start_byte == target_name_start
            })
            .ok_or("newName is not one valid identifier for the selected declaration")?;
        let fresh_locators = fresh_locator(fresh, &target_reparsed).into_iter().collect();
        Ok(EditPlanResult {
            files,
            skipped_impacts,
            fresh_locators,
        })
    }
}

fn plan_markdown_section_replacement(
    engine: &OutlineEngine,
    target: &SourceLocator,
    original: String,
    mut replacement: String,
    baseline: &OutlineFileResult,
) -> Result<EditPlanResult, Box<dyn Error>> {
    let target_level = markdown_heading_level(&target.declaration_kind, &target.signature)?;
    let replacement_outline = engine.outline_source(
        Path::new(&target.path),
        LanguageId::Markdown,
        replacement.as_bytes().to_vec(),
        true,
        false,
        &[],
    )?;
    let mut roots = entries(&replacement_outline).filter(|entry| {
        entry.symbol_type == SymbolType::Heading
            && markdown_heading_level(&entry.ast_kind, &entry.signature)
                .is_ok_and(|level| level <= target_level)
    });
    let root = roots
        .next()
        .ok_or("Markdown section replacement must start with one heading at the selected depth")?;
    if root.range.start_byte != 0
        || markdown_heading_level(&root.ast_kind, &root.signature)? != target_level
        || roots.next().is_some()
    {
        return Err(
            "Markdown section replacement must contain one root heading at the selected depth; only deeper child headings are allowed"
                .into(),
        );
    }
    if target.range.end_byte < original.len() && !replacement.ends_with('\n') {
        replacement.push_str(if original.contains("\r\n") {
            "\r\n"
        } else {
            "\n"
        });
    }
    let edit = ByteEdit {
        range: target.range.start_byte..target.range.end_byte,
        replacement,
    };
    let candidate = apply_edits(&original, std::slice::from_ref(&edit))?;
    let reparsed = parse_candidate(engine, target, &candidate, baseline)?;
    let fresh = entries(&reparsed)
        .find(|entry| {
            entry.symbol_type == SymbolType::Heading
                && entry.certainty == ParseCertainty::Certain
                && entry.range.start_byte == target.range.start_byte
                && markdown_heading_level(&entry.ast_kind, &entry.signature)
                    .is_ok_and(|level| level == target_level)
        })
        .ok_or(
            "replacement no longer produces one certain Markdown section at the selected depth",
        )?;
    finish_single_file(target, original, candidate, vec![edit], vec![fresh])
}

fn plan_markdown_body_replacement(
    engine: &OutlineEngine,
    target: &SourceLocator,
    original: String,
    body: String,
    baseline: &OutlineFileResult,
) -> Result<EditPlanResult, Box<dyn Error>> {
    let target_level = markdown_heading_level(&target.declaration_kind, &target.signature)?;
    let body_outline = engine.outline_source(
        Path::new(&target.path),
        LanguageId::Markdown,
        body.as_bytes().to_vec(),
        true,
        false,
        &[],
    )?;
    if entries(&body_outline).any(|entry| {
        entry.symbol_type == SymbolType::Heading
            && markdown_heading_level(&entry.ast_kind, &entry.signature)
                .is_ok_and(|level| level <= target_level)
    }) {
        return Err(
            "Markdown section body may contain only headings deeper than the selected heading"
                .into(),
        );
    }
    let body_range = target
        .body_range
        .clone()
        .ok_or("replace_body requires a reliable Markdown section body range")?;
    validate_range(&original, &body_range)?;
    let newline = if original.contains("\r\n") {
        "\r\n"
    } else {
        "\n"
    };
    let mut replacement = body;
    if !original[..body_range.start_byte].ends_with('\n') {
        replacement.insert_str(0, newline);
    }
    if body_range.end_byte < original.len() && !replacement.ends_with('\n') {
        replacement.push_str(newline);
    }
    let edit = ByteEdit {
        range: body_range.start_byte..body_range.end_byte,
        replacement,
    };
    let candidate = apply_edits(&original, std::slice::from_ref(&edit))?;
    let reparsed = parse_candidate(engine, target, &candidate, baseline)?;
    let fresh = entries(&reparsed)
        .find(|entry| {
            entry.symbol_type == SymbolType::Heading
                && entry.certainty == ParseCertainty::Certain
                && entry.ast_kind == target.declaration_kind
                && entry.name_range.start_byte == target.name_range.start_byte
        })
        .ok_or("replacement body no longer belongs to the selected Markdown section")?;
    finish_single_file(target, original, candidate, vec![edit], vec![fresh])
}

fn markdown_heading_level(ast_kind: &str, signature: &str) -> Result<usize, Box<dyn Error>> {
    match ast_kind {
        "atx_heading" => {
            let level = signature
                .as_bytes()
                .iter()
                .take_while(|byte| **byte == b'#')
                .count();
            if (1..=6).contains(&level) {
                Ok(level)
            } else {
                Err("Markdown heading locator has an invalid ATX heading depth".into())
            }
        }
        "setext_heading" => match signature.lines().last() {
            Some(underline) if underline.trim_start().starts_with('=') => Ok(1),
            Some(underline) if underline.trim_start().starts_with('-') => Ok(2),
            _ => Err("Markdown heading locator has an invalid Setext heading depth".into()),
        },
        _ => Err("Markdown locator does not identify a supported heading".into()),
    }
}

fn finish_single_file(
    target: &SourceLocator,
    original: String,
    candidate: String,
    edits: Vec<ByteEdit>,
    fresh: Vec<&OutlineEntry>,
) -> Result<EditPlanResult, Box<dyn Error>> {
    let fingerprint = source_fingerprint(candidate.as_bytes());
    let fresh_locators = fresh
        .into_iter()
        .filter_map(|entry| {
            entry.locator.as_ref().map(|locator| FreshLocator {
                locator: locator.clone(),
                path: target.path.clone(),
                name: entry.name.clone(),
                source_fingerprint: fingerprint.clone(),
            })
        })
        .collect();
    Ok(EditPlanResult {
        files: vec![EditFilePlan {
            path: target.path.clone(),
            expected_fingerprint: target.source_fingerprint.clone(),
            source: candidate,
            edits: planned_edits(&original, edits),
        }],
        skipped_impacts: Vec::new(),
        fresh_locators,
    })
}

fn parse_candidate(
    engine: &OutlineEngine,
    target: &SourceLocator,
    candidate: &str,
    baseline: &OutlineFileResult,
) -> Result<OutlineFileResult, Box<dyn Error>> {
    let reparsed = engine.outline_source(
        Path::new(&target.path),
        target.language,
        candidate.as_bytes().to_vec(),
        true,
        false,
        &[],
    )?;
    ensure_no_new_recovery(&reparsed, baseline)?;
    Ok(reparsed)
}

fn ensure_no_new_recovery(
    file: &OutlineFileResult,
    baseline: &OutlineFileResult,
) -> Result<(), Box<dyn Error>> {
    if file.diagnostics.error_nodes > baseline.diagnostics.error_nodes
        || file.diagnostics.missing_nodes > baseline.diagnostics.missing_nodes
    {
        return Err(format!(
            "candidate source widens parser recovery ({} ERROR, {} MISSING nodes; baseline {} ERROR, {} MISSING)",
            file.diagnostics.error_nodes,
            file.diagnostics.missing_nodes,
            baseline.diagnostics.error_nodes,
            baseline.diagnostics.missing_nodes,
        )
        .into());
    }
    Ok(())
}

fn validate_complete_repository_scope(result: &RelationshipResult) -> Result<(), Box<dyn Error>> {
    let summary = &result.summary;
    if summary.result_limit_reached
        || summary.diagnostics > 0
        || summary.file_limit_reached
        || summary.source_byte_limit_reached
        || summary.depth_limit_reached
        || summary.elapsed_limit_reached
        || result
            .relationships
            .iter()
            .any(|relationship| relationship.competing_candidates_omitted > 0)
    {
        return Err("repository rename scope is incomplete because traversal, diagnostics, or competing-candidate limits were reached".into());
    }
    Ok(())
}

fn entries(file: &OutlineFileResult) -> impl Iterator<Item = &OutlineEntry> {
    file.items
        .iter()
        .filter(|item| item.row_kind == OutlineRowKind::Declaration)
        .flat_map(|item| {
            std::iter::once(&item.entry).chain(item.members.iter().map(|member| &member.entry))
        })
}

fn parent_identity(file: &OutlineFileResult, target: &SourceLocator) -> Option<ParentIdentity> {
    entries(file)
        .filter(|entry| {
            entry.range.start_byte <= target.range.start_byte
                && entry.range.end_byte >= target.range.end_byte
                && (entry.range.start_byte != target.range.start_byte
                    || entry.range.end_byte != target.range.end_byte)
        })
        .min_by_key(|entry| entry.range.end_byte - entry.range.start_byte)
        .map(|entry| ParentIdentity {
            qualified_name: entry.qualified_name.clone(),
            ast_kind: entry.ast_kind.clone(),
            name_start: entry.name_range.start_byte,
        })
}

fn immediate_declarations<'a>(
    file: &'a OutlineFileResult,
    parent: Option<&ParentIdentity>,
) -> Result<Vec<&'a OutlineEntry>, Box<dyn Error>> {
    let all = entries(file).collect::<Vec<_>>();
    let parent_entry = match parent {
        Some(parent) => Some(
            all.iter()
                .copied()
                .find(|entry| {
                    entry.qualified_name == parent.qualified_name
                        && entry.ast_kind == parent.ast_kind
                        && entry.name_range.start_byte == parent.name_start
                })
                .ok_or("selected declaration parent no longer exists after the edit")?,
        ),
        None => None,
    };
    Ok(all
        .iter()
        .copied()
        .filter(|entry| {
            parent_entry.is_none_or(|parent| {
                !std::ptr::eq(*entry, parent)
                    && parent.range.start_byte <= entry.range.start_byte
                    && parent.range.end_byte >= entry.range.end_byte
            })
        })
        .filter(|entry| {
            !all.iter().copied().any(|container| {
                !std::ptr::eq(container, *entry)
                    && parent_entry.is_none_or(|parent| !std::ptr::eq(container, parent))
                    && container.range.start_byte <= entry.range.start_byte
                    && container.range.end_byte >= entry.range.end_byte
                    && (container.range.start_byte != entry.range.start_byte
                        || container.range.end_byte != entry.range.end_byte)
                    && parent_entry.is_none_or(|parent| {
                        parent.range.start_byte <= container.range.start_byte
                            && parent.range.end_byte >= container.range.end_byte
                    })
            })
        })
        .collect())
}

fn validate_range(source: &str, range: &SourceRange) -> Result<(), Box<dyn Error>> {
    source
        .get(range.start_byte..range.end_byte)
        .ok_or_else(|| "locator range is outside the source or splits a UTF-8 character".into())
        .map(|_| ())
}

fn apply_edits(source: &str, edits: &[ByteEdit]) -> Result<String, Box<dyn Error>> {
    let mut next = source.to_owned();
    for edit in edits.iter().rev() {
        next.get(edit.range.clone())
            .ok_or("edit range is outside the source or splits a UTF-8 character")?;
        next.replace_range(edit.range.clone(), &edit.replacement);
    }
    Ok(next)
}

fn planned_edits(source: &str, edits: Vec<ByteEdit>) -> Vec<PlannedEdit> {
    edits
        .into_iter()
        .map(|edit| PlannedEdit {
            range: source_range(source.as_bytes(), edit.range),
            replacement: edit.replacement,
        })
        .collect()
}

fn transformed_offset(offset: usize, edits: &[ByteEdit]) -> usize {
    let delta = edits
        .iter()
        .filter(|edit| edit.range.end <= offset)
        .map(|edit| edit.replacement.len() as isize - (edit.range.end - edit.range.start) as isize)
        .sum::<isize>();
    offset.saturating_add_signed(delta)
}

fn fresh_locator(entry: &OutlineEntry, file: &OutlineFileResult) -> Option<FreshLocator> {
    entry.locator.as_ref().map(|locator| FreshLocator {
        locator: locator.clone(),
        path: file.path.clone(),
        name: entry.name.clone(),
        source_fingerprint: file.source_fingerprint.clone(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::outline::{LanguageId, OutlineTarget};
    use std::path::PathBuf;

    fn budgets() -> RecursiveBudgets {
        RecursiveBudgets {
            max_files: 100,
            max_source_bytes: 1024 * 1024,
            max_depth: 8,
            max_elapsed_ms: 5_000,
        }
    }

    fn fixture(name: &str, source: &str) -> (OutlineEngine, PathBuf, String) {
        let path = std::env::temp_dir().join(format!(
            "tau-ast-edit-{name}-{}-{:?}.ts",
            std::process::id(),
            std::thread::current().id()
        ));
        fs::write(&path, source).expect("edit fixture should be writable");
        let engine = OutlineEngine::new().expect("engine");
        let outlined = engine
            .outline(
                OutlineTarget::File {
                    path: path.to_string_lossy().into_owned(),
                    language: LanguageId::TypeScript,
                },
                true,
                false,
                &[],
            )
            .expect("fixture outline");
        let locator = outlined.files[0].items[0]
            .entry
            .locator
            .clone()
            .expect("declaration locator");
        (engine, path, locator)
    }

    fn markdown_fixture(name: &str, source: &str) -> (OutlineEngine, PathBuf, String) {
        let path = std::env::temp_dir().join(format!(
            "tau-ast-edit-{name}-{}-{:?}.md",
            std::process::id(),
            std::thread::current().id()
        ));
        fs::write(&path, source).expect("Markdown edit fixture should be writable");
        let engine = OutlineEngine::new().expect("engine");
        let outlined = engine
            .outline(
                OutlineTarget::File {
                    path: path.to_string_lossy().into_owned(),
                    language: LanguageId::Markdown,
                },
                true,
                false,
                &["Guide.Installation".to_owned()],
            )
            .expect("Markdown fixture outline");
        let locator = outlined.files[0].items[0]
            .entry
            .locator
            .clone()
            .expect("Markdown section locator");
        (engine, path, locator)
    }

    #[test]
    fn plans_declaration_body_and_adjacent_insertions_without_writing() {
        let original =
            "/** docs */\nexport function target(value: number) {\n  return value + 1;\n}\n";

        for (name, operation, expected) in [
            (
                "declaration",
                EditOperation::ReplaceDeclaration {
                    source: "export function target(value: number) { return value + 2; }"
                        .to_owned(),
                },
                "return value + 2",
            ),
            (
                "body",
                EditOperation::ReplaceBody {
                    body: "{\n  return value + 3;\n}".to_owned(),
                },
                "/** docs */\nexport function target(value: number) {\n  return value + 3;\n}",
            ),
            (
                "insert-before",
                EditOperation::InsertDeclaration {
                    position: InsertPosition::Before,
                    source: "export const before = 1;".to_owned(),
                },
                "export const before = 1;\n/** docs */",
            ),
            (
                "insert-after",
                EditOperation::InsertDeclaration {
                    position: InsertPosition::After,
                    source: "export const after = 1;".to_owned(),
                },
                "}\nexport const after = 1;",
            ),
        ] {
            let (engine, path, locator) = fixture(name, original);
            let plan = engine
                .plan_edit(&locator, operation, budgets())
                .expect("edit should plan");
            assert_eq!(fs::read_to_string(&path).expect("fixture"), original);
            assert!(plan.files[0].source.contains(expected), "{name}");
            assert!(!plan.fresh_locators.is_empty(), "{name}");
            fs::remove_file(path).expect("remove fixture");
        }
    }

    #[test]
    fn plans_repository_rename_and_skips_unapproved_inferred_references() {
        let directory = std::env::temp_dir().join(format!(
            "tau-ast-edit-rename-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        fs::create_dir_all(&directory).expect("rename fixture directory");
        let target_path = directory.join("target.ts");
        fs::write(
            &target_path,
            "export function target(value: number) { return value; }\n",
        )
        .expect("target fixture");
        fs::write(
            directory.join("caller.ts"),
            "import { target } from './target.ts';\nexport const value = target(1);\nexport const unrelated = { target: 2 }.target;\n",
        )
        .expect("caller fixture");
        fs::write(
            directory.join("inferred.ts"),
            "export const value = target(2);\n",
        )
        .expect("inferred fixture");
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
            .as_ref()
            .expect("target locator");
        let plan = engine
            .plan_edit(
                locator,
                EditOperation::RenameDeclaration {
                    new_name: "renamed".to_owned(),
                    scope: RenameScope::Repository {
                        path: directory.to_string_lossy().into_owned(),
                    },
                    include_inferred: false,
                },
                budgets(),
            )
            .expect("rename should plan");

        assert!(plan.files.iter().any(|file| {
            file.path.ends_with("target.ts") && file.source.contains("function renamed")
        }));
        assert!(plan.files.iter().any(|file| {
            file.path.ends_with("caller.ts")
                && file.source.contains("renamed(1)")
                && file.source.contains("{ target: 2 }.target")
        }));
        assert!(plan.skipped_impacts.iter().any(|impact| {
            impact.path.ends_with("inferred.ts") && impact.reason == "inferredNotApproved"
        }));
        assert!(
            plan.fresh_locators
                .iter()
                .any(|fresh| fresh.name == "renamed")
        );
        fs::remove_dir_all(directory).expect("remove rename fixture");
    }

    #[test]
    fn rejects_stale_declaration_locators_before_planning() {
        let (engine, path, locator) = fixture("stale", "export function target() { return 1; }\n");
        fs::write(&path, "export function target() { return 2; }\n").expect("mutate fixture");
        let error = engine
            .plan_edit(
                &locator,
                EditOperation::ReplaceBody {
                    body: "{ return 3; }".to_owned(),
                },
                budgets(),
            )
            .expect_err("stale locator should fail");
        assert!(error.to_string().contains("source changed"));
        fs::remove_file(path).expect("remove fixture");
    }

    #[test]
    fn validates_one_replacement_unit_without_counting_nested_members() {
        let (engine, path, locator) = fixture(
            "container-unit",
            "export class Target { first(): number { return 1; } }\n",
        );
        let plan = engine
            .plan_edit(
                &locator,
                EditOperation::ReplaceDeclaration {
                    source: "export class Target { first(): number { return 1; } second(): number { return 2; } }"
                        .to_owned(),
                },
                budgets(),
            )
            .expect("nested member count must not change the replacement unit count");
        assert!(plan.files[0].source.contains("second(): number"));
        assert_eq!(plan.fresh_locators.len(), 1);
        fs::remove_file(path).expect("remove fixture");
    }

    #[test]
    fn replaces_markdown_sections_and_bodies_without_textual_context() {
        let original = "# Guide\n\nIntro.\n\n## Installation\n\nOld.\n\n### macOS\n\nOld child.\n\n## Next\n\nKeep.\n";
        let (engine, path, locator) = markdown_fixture("markdown-section", original);
        let plan = engine
            .plan_edit(
                &locator,
                EditOperation::ReplaceDeclaration {
                    source: "## Setup\n\nNew.\n\n### Linux\n\nNew child.".to_owned(),
                },
                budgets(),
            )
            .expect("complete Markdown section should plan");
        assert!(
            plan.files[0]
                .source
                .contains("## Setup\n\nNew.\n\n### Linux")
        );
        assert!(plan.files[0].source.contains("## Next\n\nKeep."));
        assert!(!plan.files[0].source.contains("Old child."));
        assert_eq!(plan.fresh_locators[0].name, "Setup");
        assert_eq!(fs::read_to_string(&path).expect("fixture"), original);
        fs::remove_file(path).expect("remove fixture");

        let (engine, path, locator) = markdown_fixture("markdown-body", original);
        let plan = engine
            .plan_edit(
                &locator,
                EditOperation::ReplaceBody {
                    body: "New body.\n\n### Linux\n\nNew child.".to_owned(),
                },
                budgets(),
            )
            .expect("Markdown section body should plan");
        assert!(
            plan.files[0]
                .source
                .contains("## Installation\nNew body.\n\n### Linux")
        );
        assert!(plan.files[0].source.contains("## Next\n\nKeep."));
        assert_eq!(plan.fresh_locators[0].name, "Installation");
        assert_eq!(fs::read_to_string(&path).expect("fixture"), original);
        fs::remove_file(path).expect("remove fixture");
    }

    #[test]
    fn rejects_markdown_replacements_that_escape_the_selected_section_depth() {
        let original = "# Guide\n\n## Installation\n\nOld.\n\n## Next\n\nKeep.\n";
        for (name, operation) in [
            (
                "markdown-wrong-root",
                EditOperation::ReplaceDeclaration {
                    source: "### Too Deep\n\nText.".to_owned(),
                },
            ),
            (
                "markdown-body-sibling",
                EditOperation::ReplaceBody {
                    body: "Text.\n\n## Escaped\n\nNo.".to_owned(),
                },
            ),
        ] {
            let (engine, path, locator) = markdown_fixture(name, original);
            let error = engine
                .plan_edit(&locator, operation, budgets())
                .expect_err("replacement must remain inside the selected section depth");
            assert!(error.to_string().contains("heading"), "{name}: {error}");
            assert_eq!(fs::read_to_string(&path).expect("fixture"), original);
            fs::remove_file(path).expect("remove fixture");
        }
    }
}
