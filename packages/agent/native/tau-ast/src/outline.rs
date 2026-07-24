use crate::language::OdinLanguage;
use ast_grep_config::GlobalRules;
use ast_grep_core::{Node, tree_sitter::LanguageExt};
use ast_grep_language::SupportLang;
use ast_grep_outline::{
    DEFAULT_OUTLINE_RULES,
    combined_extractor::CombinedExtractors,
    extractor::parse_outline_rules,
    model::{
        EntryRole as AstEntryRole, OutlineEntry as AstOutlineEntry, OutlineItem as AstOutlineItem,
        SymbolType as AstSymbolType,
    },
};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    error::Error,
    fmt, fs,
    path::Path,
    str,
};

const LOCATOR_VERSION: u32 = 1;

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum LanguageId {
    TypeScript,
    Tsx,
    Odin,
    Go,
    Rust,
    CSharp,
    Java,
    Kotlin,
    Swift,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum OutlineTarget {
    File { path: String, language: LanguageId },
    Directory { path: String },
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutlineTargetResult {
    pub path: String,
    pub files: Vec<OutlineFileResult>,
    pub total_byte_length: usize,
    pub total_line_count: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutlineFileResult {
    pub path: String,
    pub language: LanguageId,
    pub source_fingerprint: String,
    pub byte_length: usize,
    pub line_count: usize,
    pub diagnostics: ParseDiagnostics,
    pub items: Vec<OutlineItem>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParseDiagnostics {
    pub error_nodes: usize,
    pub missing_nodes: usize,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourcePosition {
    pub line: usize,
    pub column: usize,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceRange {
    pub start_byte: usize,
    pub end_byte: usize,
    pub start: SourcePosition,
    pub end: SourcePosition,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum EntryRole {
    Item,
    Member,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SymbolType {
    File,
    Module,
    Namespace,
    Package,
    Class,
    Method,
    Property,
    Field,
    Constructor,
    Enum,
    Interface,
    Function,
    Variable,
    Constant,
    String,
    Number,
    Boolean,
    Array,
    Object,
    Key,
    Null,
    EnumMember,
    Struct,
    Event,
    Operator,
    TypeParameter,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutlineEntry {
    pub role: EntryRole,
    pub symbol_type: SymbolType,
    pub name: String,
    pub range: SourceRange,
    pub signature: String,
    pub ast_kind: String,
    pub locator: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutlineItem {
    #[serde(flatten)]
    pub entry: OutlineEntry,
    pub is_import: bool,
    pub is_exported: bool,
    pub members: Vec<OutlineMember>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutlineMember {
    #[serde(flatten)]
    pub entry: OutlineEntry,
    pub is_public: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SymbolBatchResult {
    pub declarations: Vec<SymbolDeclaration>,
    pub blocks: Vec<SymbolBlock>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SymbolDeclaration {
    pub locator: String,
    pub path: String,
    pub language: LanguageId,
    pub source_fingerprint: String,
    pub declaration_range: SourceRange,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SymbolBlock {
    pub path: String,
    pub returned_range: SourceRange,
    pub declaration_indexes: Vec<usize>,
    pub source: String,
}

#[derive(Debug)]
pub struct SymbolError {
    pub code: &'static str,
    pub message: String,
}

impl fmt::Display for SymbolError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl Error for SymbolError {}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SourceLocator {
    version: u32,
    path: String,
    language: LanguageId,
    source_fingerprint: String,
    range: SourceRange,
}

pub struct OutlineEngine {
    typescript: CombinedExtractors<SupportLang>,
    tsx: CombinedExtractors<SupportLang>,
    go: CombinedExtractors<SupportLang>,
    rust: CombinedExtractors<SupportLang>,
    c_sharp: CombinedExtractors<SupportLang>,
    java: CombinedExtractors<SupportLang>,
    kotlin: CombinedExtractors<SupportLang>,
    swift: CombinedExtractors<SupportLang>,
    odin: CombinedExtractors<OdinLanguage>,
}

impl OutlineEngine {
    pub fn new() -> Result<Self, Box<dyn Error>> {
        let default_rules = parse_outline_rules::<SupportLang>(DEFAULT_OUTLINE_RULES)?;
        let typescript_rules = default_rules
            .iter()
            .filter(|rule| rule.common().language == SupportLang::TypeScript)
            .cloned()
            .collect();
        let tsx_rules = default_rules
            .iter()
            .filter(|rule| rule.common().language == SupportLang::Tsx)
            .cloned()
            .collect();
        let go_rules = default_rules
            .iter()
            .filter(|rule| rule.common().language == SupportLang::Go)
            .cloned()
            .collect();
        let rust_rules = default_rules
            .iter()
            .filter(|rule| rule.common().language == SupportLang::Rust)
            .cloned()
            .collect();
        let c_sharp_rules = default_rules
            .iter()
            .filter(|rule| rule.common().language == SupportLang::CSharp)
            .cloned()
            .collect();
        let java_rules = default_rules
            .iter()
            .filter(|rule| rule.common().language == SupportLang::Java)
            .cloned()
            .collect();
        let kotlin_rules = default_rules
            .iter()
            .filter(|rule| rule.common().language == SupportLang::Kotlin)
            .cloned()
            .collect();
        let swift_rules = default_rules
            .iter()
            .filter(|rule| rule.common().language == SupportLang::Swift)
            .cloned()
            .collect();
        let odin_rules = parse_outline_rules::<OdinLanguage>(include_str!("../rules/odin.yml"))?;
        let globals = GlobalRules::default();

        Ok(Self {
            typescript: CombinedExtractors::try_from(typescript_rules, &globals)?,
            tsx: CombinedExtractors::try_from(tsx_rules, &globals)?,
            go: CombinedExtractors::try_from(go_rules, &globals)?,
            rust: CombinedExtractors::try_from(rust_rules, &globals)?,
            c_sharp: CombinedExtractors::try_from(c_sharp_rules, &globals)?,
            java: CombinedExtractors::try_from(java_rules, &globals)?,
            kotlin: CombinedExtractors::try_from(kotlin_rules, &globals)?,
            swift: CombinedExtractors::try_from(swift_rules, &globals)?,
            odin: CombinedExtractors::try_from(odin_rules, &globals)?,
        })
    }

    pub fn outline(
        &self,
        target: OutlineTarget,
        include_private: bool,
        names: &[String],
    ) -> Result<OutlineTargetResult, Box<dyn Error>> {
        let (path, files) = match target {
            OutlineTarget::File { path, language } => {
                let path = fs::canonicalize(&path)?;
                if !path.is_file() {
                    return Err(
                        format!("outline file target is not a file: {}", path.display()).into(),
                    );
                }
                let inferred = language_for_path(&path).ok_or_else(|| {
                    format!(
                        "unsupported outline file type: {}",
                        path.extension()
                            .and_then(|extension| extension.to_str())
                            .map_or_else(
                                || "no extension".to_owned(),
                                |extension| format!(".{extension}")
                            )
                    )
                })?;
                if inferred != language {
                    return Err(format!(
                        "outline language {language:?} does not match {}",
                        path.display()
                    )
                    .into());
                }
                let file = self.outline_file(&path, language, include_private, names)?;
                (path, vec![file])
            }
            OutlineTarget::Directory { path } => {
                let path = fs::canonicalize(&path)?;
                if !path.is_dir() {
                    return Err(format!(
                        "outline directory target is not a directory: {}",
                        path.display()
                    )
                    .into());
                }
                let mut candidates = Vec::new();
                for entry in fs::read_dir(&path)? {
                    let entry = entry?;
                    let entry_path = entry.path();
                    if !entry_path.is_file() {
                        continue;
                    }
                    let Some(language) = language_for_path(&entry_path) else {
                        continue;
                    };
                    candidates.push((fs::canonicalize(entry_path)?, language));
                }
                candidates.sort_by(|left, right| left.0.cmp(&right.0));
                candidates.dedup_by(|left, right| left.0 == right.0);
                if candidates.is_empty() {
                    return Err(format!(
                        "directory contains no supported source files: {}",
                        path.display()
                    )
                    .into());
                }
                let families = candidates
                    .iter()
                    .map(|(_, language)| language_family(*language))
                    .collect::<BTreeSet<_>>();
                if families.len() > 1 {
                    let languages = candidates
                        .iter()
                        .map(|(_, language)| format!("{language:?}"))
                        .collect::<BTreeSet<_>>()
                        .into_iter()
                        .collect::<Vec<_>>()
                        .join(", ");
                    return Err(format!(
                        "directory contains mixed supported language families ({languages}): {}",
                        path.display()
                    )
                    .into());
                }
                let files = candidates
                    .into_iter()
                    .map(|(file_path, language)| {
                        self.outline_file(&file_path, language, include_private, names)
                    })
                    .collect::<Result<Vec<_>, _>>()?;
                (path, files)
            }
        };
        let total_byte_length = files.iter().map(|file| file.byte_length).sum();
        let total_line_count = files.iter().map(|file| file.line_count).sum();

        Ok(OutlineTargetResult {
            path: path.to_string_lossy().into_owned(),
            files,
            total_byte_length,
            total_line_count,
        })
    }

    fn outline_file(
        &self,
        path: &Path,
        language: LanguageId,
        include_private: bool,
        names: &[String],
    ) -> Result<OutlineFileResult, Box<dyn Error>> {
        let source_bytes = fs::read(&path)?;
        let source = str::from_utf8(&source_bytes)?;
        let path = path.to_string_lossy().into_owned();
        let source_fingerprint = source_fingerprint(&source_bytes);
        let (diagnostics, mut items) = match language {
            LanguageId::TypeScript => {
                let grep = SupportLang::TypeScript.ast_grep(source);
                (
                    diagnostics(grep.root()),
                    self.typescript
                        .extract(grep.root())
                        .map(|item| outline_item(item, &path, language, &source_fingerprint))
                        .collect::<Result<Vec<_>, _>>()?,
                )
            }
            LanguageId::Tsx => {
                let grep = SupportLang::Tsx.ast_grep(source);
                (
                    diagnostics(grep.root()),
                    self.tsx
                        .extract(grep.root())
                        .map(|item| outline_item(item, &path, language, &source_fingerprint))
                        .collect::<Result<Vec<_>, _>>()?,
                )
            }
            LanguageId::Odin => {
                let grep = OdinLanguage::Odin.ast_grep(source);
                (
                    diagnostics(grep.root()),
                    self.odin
                        .extract(grep.root())
                        .map(|item| outline_item(item, &path, language, &source_fingerprint))
                        .collect::<Result<Vec<_>, _>>()?,
                )
            }
            LanguageId::Go => {
                let grep = SupportLang::Go.ast_grep(source);
                (
                    diagnostics(grep.root()),
                    self.go
                        .extract(grep.root())
                        .map(|item| outline_item(item, &path, language, &source_fingerprint))
                        .collect::<Result<Vec<_>, _>>()?,
                )
            }
            LanguageId::Rust => {
                let grep = SupportLang::Rust.ast_grep(source);
                (
                    diagnostics(grep.root()),
                    self.rust
                        .extract(grep.root())
                        .map(|item| outline_item(item, &path, language, &source_fingerprint))
                        .collect::<Result<Vec<_>, _>>()?,
                )
            }
            LanguageId::CSharp => {
                let grep = SupportLang::CSharp.ast_grep(source);
                (
                    diagnostics(grep.root()),
                    self.c_sharp
                        .extract(grep.root())
                        .map(|item| outline_item(item, &path, language, &source_fingerprint))
                        .collect::<Result<Vec<_>, _>>()?,
                )
            }
            LanguageId::Java => {
                let grep = SupportLang::Java.ast_grep(source);
                (
                    diagnostics(grep.root()),
                    self.java
                        .extract(grep.root())
                        .map(|item| outline_item(item, &path, language, &source_fingerprint))
                        .collect::<Result<Vec<_>, _>>()?,
                )
            }
            LanguageId::Kotlin => {
                let grep = SupportLang::Kotlin.ast_grep(source);
                (
                    diagnostics(grep.root()),
                    self.kotlin
                        .extract(grep.root())
                        .map(|item| outline_item(item, &path, language, &source_fingerprint))
                        .collect::<Result<Vec<_>, _>>()?,
                )
            }
            LanguageId::Swift => {
                let grep = SupportLang::Swift.ast_grep(source);
                (
                    diagnostics(grep.root()),
                    self.swift
                        .extract(grep.root())
                        .map(|item| outline_item(item, &path, language, &source_fingerprint))
                        .collect::<Result<Vec<_>, _>>()?,
                )
            }
        };
        let line_count = if source.is_empty() {
            0
        } else {
            source.bytes().filter(|byte| *byte == b'\n').count() + 1
        };
        filter_items(&mut items, include_private, names);

        Ok(OutlineFileResult {
            path,
            language,
            source_fingerprint,
            byte_length: source.len(),
            line_count,
            diagnostics,
            items,
        })
    }

    pub fn symbol(
        &self,
        encoded_locators: &[String],
        context_lines: usize,
    ) -> Result<SymbolBatchResult, SymbolError> {
        if encoded_locators.is_empty() {
            return Err(SymbolError {
                code: "invalid_locator",
                message: "symbol requires at least one locator".to_owned(),
            });
        }

        let mut seen = BTreeSet::new();
        let mut locators = Vec::new();
        for encoded_locator in encoded_locators {
            if !seen.insert(encoded_locator.as_str()) {
                continue;
            }
            let locator_bytes =
                URL_SAFE_NO_PAD
                    .decode(encoded_locator)
                    .map_err(|error| SymbolError {
                        code: "invalid_locator",
                        message: format!("locator is not valid base64url: {error}"),
                    })?;
            let mut locator: SourceLocator =
                serde_json::from_slice(&locator_bytes).map_err(|error| SymbolError {
                    code: "invalid_locator",
                    message: format!("locator payload is invalid: {error}"),
                })?;
            if locator.version != LOCATOR_VERSION {
                return Err(SymbolError {
                    code: "invalid_locator",
                    message: format!(
                        "locator version {} is unsupported; worker uses {LOCATOR_VERSION}",
                        locator.version
                    ),
                });
            }
            locator.path = fs::canonicalize(&locator.path)
                .map_err(|error| SymbolError {
                    code: "symbol_failed",
                    message: format!("failed to resolve {}: {error}", locator.path),
                })?
                .to_string_lossy()
                .into_owned();
            locators.push((encoded_locator.clone(), locator));
        }
        locators.sort_by(|left, right| {
            left.1
                .path
                .cmp(&right.1.path)
                .then(left.1.range.start_byte.cmp(&right.1.range.start_byte))
                .then(left.1.range.end_byte.cmp(&right.1.range.end_byte))
                .then(left.0.cmp(&right.0))
        });

        let mut sources = BTreeMap::new();
        for (_, locator) in &locators {
            if sources.contains_key(&locator.path) {
                continue;
            }
            let source_bytes = fs::read(&locator.path).map_err(|error| SymbolError {
                code: "symbol_failed",
                message: format!("failed to read {}: {error}", locator.path),
            })?;
            let current_fingerprint = source_fingerprint(&source_bytes);
            if current_fingerprint != locator.source_fingerprint {
                return Err(SymbolError {
                    code: "stale_locator",
                    message: format!(
                        "source changed since the locator was created; request a fresh outline for {}",
                        locator.path
                    ),
                });
            }
            let source = String::from_utf8(source_bytes).map_err(|error| SymbolError {
                code: "symbol_failed",
                message: format!("{} is not valid UTF-8: {error}", locator.path),
            })?;
            sources.insert(locator.path.clone(), source);
        }
        for (_, locator) in &locators {
            let source = sources.get(&locator.path).ok_or_else(|| SymbolError {
                code: "symbol_failed",
                message: format!("failed to retain source for {}", locator.path),
            })?;
            if source_fingerprint(source.as_bytes()) != locator.source_fingerprint {
                return Err(SymbolError {
                    code: "stale_locator",
                    message: format!(
                        "source changed since the locator was created; request a fresh outline for {}",
                        locator.path
                    ),
                });
            }
            source
                .get(locator.range.start_byte..locator.range.end_byte)
                .ok_or_else(|| SymbolError {
                    code: "invalid_locator",
                    message: "locator range is outside the source or splits a UTF-8 character"
                        .to_owned(),
                })?;
        }

        let declarations = locators
            .iter()
            .map(|(encoded_locator, locator)| SymbolDeclaration {
                locator: encoded_locator.clone(),
                path: locator.path.clone(),
                language: locator.language,
                source_fingerprint: locator.source_fingerprint.clone(),
                declaration_range: locator.range.clone(),
            })
            .collect::<Vec<_>>();
        let mut padded = Vec::<(String, usize, usize, Vec<usize>)>::new();
        for (index, (_, locator)) in locators.iter().enumerate() {
            let source = sources.get(&locator.path).ok_or_else(|| SymbolError {
                code: "symbol_failed",
                message: format!("failed to retain source for {}", locator.path),
            })?;
            let (start_byte, end_byte) =
                padded_range(source.as_bytes(), &locator.range, context_lines);
            if let Some((path, _, previous_end, declaration_indexes)) = padded.last_mut()
                && *path == locator.path
                && start_byte <= *previous_end
            {
                *previous_end = (*previous_end).max(end_byte);
                declaration_indexes.push(index);
            } else {
                padded.push((locator.path.clone(), start_byte, end_byte, vec![index]));
            }
        }
        let blocks = padded
            .into_iter()
            .map(|(path, start_byte, end_byte, declaration_indexes)| {
                let source = sources.get(&path).ok_or_else(|| SymbolError {
                    code: "symbol_failed",
                    message: format!("failed to retain source for {path}"),
                })?;
                Ok(SymbolBlock {
                    path,
                    returned_range: source_range(source.as_bytes(), start_byte, end_byte),
                    declaration_indexes,
                    source: source[start_byte..end_byte].to_owned(),
                })
            })
            .collect::<Result<Vec<_>, SymbolError>>()?;

        Ok(SymbolBatchResult {
            declarations,
            blocks,
        })
    }
}

fn filter_items(items: &mut Vec<OutlineItem>, include_private: bool, names: &[String]) {
    let names = names.iter().map(String::as_str).collect::<BTreeSet<_>>();
    if names.is_empty() {
        items.retain_mut(|item| {
            item.members
                .retain(|member| include_private || member.is_public);
            item.is_import || include_private || item.is_exported
        });
        return;
    }
    items.retain_mut(|item| {
        if item.is_import {
            item.members.clear();
            return true;
        }
        let item_is_visible = include_private || item.is_exported;
        let item_matches = names.contains(item.entry.name.as_str());
        item.members.retain(|member| {
            item_is_visible
                && names.contains(member.entry.name.as_str())
                && (include_private || member.is_public)
        });
        item_is_visible && (item_matches || !item.members.is_empty())
    });
}

fn padded_range(source: &[u8], declaration: &SourceRange, context_lines: usize) -> (usize, usize) {
    if context_lines == 0 {
        return (declaration.start_byte, declaration.end_byte);
    }
    let mut line_starts = vec![0];
    line_starts.extend(
        source
            .iter()
            .enumerate()
            .filter_map(|(index, byte)| (*byte == b'\n').then_some(index + 1)),
    );
    let start_line = declaration.start.line.saturating_sub(context_lines);
    let declaration_end_line = if declaration.end_byte > declaration.start_byte
        && source.get(declaration.end_byte - 1) == Some(&b'\n')
    {
        declaration.end.line.saturating_sub(1)
    } else {
        declaration.end.line
    };
    let end_line = declaration_end_line
        .saturating_add(context_lines)
        .min(line_starts.len().saturating_sub(1));
    let start_byte = line_starts.get(start_line).copied().unwrap_or(0);
    let end_byte = line_starts
        .get(end_line + 1)
        .copied()
        .unwrap_or(source.len());
    (start_byte, end_byte)
}

fn source_range(source: &[u8], start_byte: usize, end_byte: usize) -> SourceRange {
    SourceRange {
        start_byte,
        end_byte,
        start: source_position(source, start_byte),
        end: source_position(source, end_byte),
    }
}

fn source_position(source: &[u8], byte_offset: usize) -> SourcePosition {
    let prefix = &source[..byte_offset];
    let line = prefix.iter().filter(|byte| **byte == b'\n').count();
    let column = prefix
        .iter()
        .rposition(|byte| *byte == b'\n')
        .map_or(prefix.len(), |newline| prefix.len() - newline - 1);
    SourcePosition { line, column }
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
enum LanguageFamily {
    TypeScript,
    Odin,
    Go,
    Rust,
    CSharp,
    Java,
    Kotlin,
    Swift,
}

fn language_family(language: LanguageId) -> LanguageFamily {
    match language {
        LanguageId::TypeScript | LanguageId::Tsx => LanguageFamily::TypeScript,
        LanguageId::Odin => LanguageFamily::Odin,
        LanguageId::Go => LanguageFamily::Go,
        LanguageId::Rust => LanguageFamily::Rust,
        LanguageId::CSharp => LanguageFamily::CSharp,
        LanguageId::Java => LanguageFamily::Java,
        LanguageId::Kotlin => LanguageFamily::Kotlin,
        LanguageId::Swift => LanguageFamily::Swift,
    }
}

fn language_for_path(path: &Path) -> Option<LanguageId> {
    match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "ts" => Some(LanguageId::TypeScript),
        "tsx" => Some(LanguageId::Tsx),
        "odin" => Some(LanguageId::Odin),
        "go" => Some(LanguageId::Go),
        "rs" => Some(LanguageId::Rust),
        "cs" => Some(LanguageId::CSharp),
        "java" => Some(LanguageId::Java),
        "kt" | "ktm" | "kts" => Some(LanguageId::Kotlin),
        "swift" => Some(LanguageId::Swift),
        _ => None,
    }
}

fn diagnostics<D: ast_grep_core::Doc>(root: Node<D>) -> ParseDiagnostics {
    root.dfs().fold(
        ParseDiagnostics {
            error_nodes: 0,
            missing_nodes: 0,
        },
        |mut diagnostics, node| {
            diagnostics.error_nodes += usize::from(node.is_error());
            diagnostics.missing_nodes += usize::from(node.is_missing());
            diagnostics
        },
    )
}

fn outline_item(
    item: AstOutlineItem<'_>,
    path: &str,
    language: LanguageId,
    source_fingerprint: &str,
) -> Result<OutlineItem, serde_json::Error> {
    let is_exported = public_visibility(
        language,
        item.is_exported,
        item.entry.name.as_ref(),
        item.entry.signature.as_ref(),
    );
    Ok(OutlineItem {
        entry: outline_entry(item.entry, path, language, source_fingerprint)?,
        is_import: item.is_import,
        is_exported,
        members: item
            .members
            .into_iter()
            .map(|member| {
                let is_public = public_visibility(
                    language,
                    member.is_public,
                    member.entry.name.as_ref(),
                    member.entry.signature.as_ref(),
                );
                Ok(OutlineMember {
                    entry: outline_entry(member.entry, path, language, source_fingerprint)?,
                    is_public,
                })
            })
            .collect::<Result<Vec<_>, serde_json::Error>>()?,
    })
}

fn public_visibility(language: LanguageId, extracted: bool, name: &str, signature: &str) -> bool {
    match language {
        LanguageId::Go => name.chars().next().is_some_and(char::is_uppercase),
        LanguageId::Rust => extracted && !signature.trim_start().starts_with("pub("),
        _ => extracted,
    }
}

fn outline_entry(
    entry: AstOutlineEntry<'_>,
    path: &str,
    language: LanguageId,
    source_fingerprint: &str,
) -> Result<OutlineEntry, serde_json::Error> {
    let range = SourceRange {
        start_byte: entry.range.byte_offset.start,
        end_byte: entry.range.byte_offset.end,
        start: SourcePosition {
            line: entry.range.start.line,
            column: entry.range.start.column,
        },
        end: SourcePosition {
            line: entry.range.end.line,
            column: entry.range.end.column,
        },
    };
    let locator = SourceLocator {
        version: LOCATOR_VERSION,
        path: path.to_owned(),
        language,
        source_fingerprint: source_fingerprint.to_owned(),
        range: range.clone(),
    };

    Ok(OutlineEntry {
        role: match entry.role {
            AstEntryRole::Item => EntryRole::Item,
            AstEntryRole::Member => EntryRole::Member,
        },
        symbol_type: entry.symbol_type.into(),
        name: entry.name.into_owned(),
        range,
        signature: entry.signature.into_owned(),
        ast_kind: entry.ast_kind.into_owned(),
        locator: URL_SAFE_NO_PAD.encode(serde_json::to_vec(&locator)?),
    })
}

fn source_fingerprint(source: &[u8]) -> String {
    format!("blake3:{}", blake3::hash(source).to_hex())
}

impl From<AstSymbolType> for SymbolType {
    fn from(symbol_type: AstSymbolType) -> Self {
        match symbol_type {
            AstSymbolType::File => Self::File,
            AstSymbolType::Module => Self::Module,
            AstSymbolType::Namespace => Self::Namespace,
            AstSymbolType::Package => Self::Package,
            AstSymbolType::Class => Self::Class,
            AstSymbolType::Method => Self::Method,
            AstSymbolType::Property => Self::Property,
            AstSymbolType::Field => Self::Field,
            AstSymbolType::Constructor => Self::Constructor,
            AstSymbolType::Enum => Self::Enum,
            AstSymbolType::Interface => Self::Interface,
            AstSymbolType::Function => Self::Function,
            AstSymbolType::Variable => Self::Variable,
            AstSymbolType::Constant => Self::Constant,
            AstSymbolType::String => Self::String,
            AstSymbolType::Number => Self::Number,
            AstSymbolType::Boolean => Self::Boolean,
            AstSymbolType::Array => Self::Array,
            AstSymbolType::Object => Self::Object,
            AstSymbolType::Key => Self::Key,
            AstSymbolType::Null => Self::Null,
            AstSymbolType::EnumMember => Self::EnumMember,
            AstSymbolType::Struct => Self::Struct,
            AstSymbolType::Event => Self::Event,
            AstSymbolType::Operator => Self::Operator,
            AstSymbolType::TypeParameter => Self::TypeParameter,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn outline_file(
        engine: &OutlineEngine,
        path: &Path,
        language: LanguageId,
    ) -> OutlineFileResult {
        engine
            .outline(
                OutlineTarget::File {
                    path: path.to_string_lossy().into_owned(),
                    language,
                },
                true,
                &[],
            )
            .expect("fixture should parse")
            .files
            .into_iter()
            .next()
            .expect("file target should return one file")
    }

    #[test]
    fn extracts_typescript_fixture() {
        let engine = OutlineEngine::new().expect("outline rules should compile");
        let fixture = Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/typescript.ts");
        let result = outline_file(&engine, &fixture, LanguageId::TypeScript);
        let names = result
            .items
            .iter()
            .map(|item| item.entry.name.as_str())
            .collect::<Vec<_>>();

        assert_eq!(result.diagnostics.error_nodes, 0);
        assert_eq!(result.diagnostics.missing_nodes, 0);
        assert!(names.contains(&"Parser"));
        assert!(names.contains(&"Result"));
        assert!(names.contains(&"FileParser"));
        assert!(names.contains(&"createParser"));
        assert!(
            result
                .items
                .iter()
                .all(|item| !item.entry.locator.is_empty())
        );
    }

    #[test]
    fn extracts_odin_fixture() {
        let engine = OutlineEngine::new().expect("outline rules should compile");
        let fixture = Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/odin.odin");
        let result = outline_file(&engine, &fixture, LanguageId::Odin);
        let names = result
            .items
            .iter()
            .map(|item| item.entry.name.as_str())
            .collect::<Vec<_>>();

        assert_eq!(result.diagnostics.error_nodes, 0);
        assert_eq!(result.diagnostics.missing_nodes, 0);
        assert!(names.contains(&"EPSILON"));
        assert!(names.contains(&"Circle"));
        assert!(names.contains(&"Shape_Kind"));
        assert!(names.contains(&"vec2_length"));
        assert!(names.contains(&"lerp"));

        let hidden = result
            .items
            .iter()
            .find(|item| item.entry.name == "hidden_length")
            .expect("private procedure should be extracted");
        assert!(!hidden.is_exported);
    }

    #[test]
    fn extracts_bundled_language_fixtures_and_retrieves_exact_symbols() {
        let engine = OutlineEngine::new().expect("outline rules should compile");
        let cases: [(LanguageId, &str, &[&str]); 6] = [
            (
                LanguageId::Go,
                "go.go",
                &["Parser", "Result", "FileParser", "NewParser"],
            ),
            (
                LanguageId::Rust,
                "rust.rs",
                &["Parser", "Result", "FileParser", "create_parser"],
            ),
            (
                LanguageId::CSharp,
                "csharp.cs",
                &["IParser", "Result", "FileParser"],
            ),
            (
                LanguageId::Java,
                "java.java",
                &["Parser", "Result", "FileParser"],
            ),
            (
                LanguageId::Kotlin,
                "kotlin.kt",
                &["Parser", "Result", "FileParser", "createParser"],
            ),
            (
                LanguageId::Swift,
                "swift.swift",
                &["Parser", "Result", "FileParser", "createParser"],
            ),
        ];

        for (language, file, expected_names) in cases {
            let fixture = Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("fixtures")
                .join(file);
            let source = fs::read_to_string(&fixture).expect("fixture should be readable");
            let result = outline_file(&engine, &fixture, language);
            let names = result
                .items
                .iter()
                .map(|item| item.entry.name.as_str())
                .collect::<Vec<_>>();

            assert_eq!(result.diagnostics.error_nodes, 0, "{file}");
            assert_eq!(result.diagnostics.missing_nodes, 0, "{file}");
            for expected_name in expected_names {
                assert!(
                    names.contains(expected_name),
                    "{file} omitted {expected_name}"
                );
            }

            let item = result
                .items
                .iter()
                .find(|item| !item.is_import)
                .expect("fixture should contain a declaration");
            let symbol = engine
                .symbol(std::slice::from_ref(&item.entry.locator), 0)
                .expect("fresh locator should resolve");
            assert_eq!(
                symbol.blocks[0].source,
                source[item.entry.range.start_byte..item.entry.range.end_byte],
                "{file}"
            );
        }
    }

    #[test]
    fn filters_go_and_rust_package_private_declarations() {
        let engine = OutlineEngine::new().expect("outline rules should compile");
        for (language, file, private_name) in [
            (LanguageId::Go, "go.go", "hiddenParser"),
            (LanguageId::Rust, "rust.rs", "internal_parser"),
        ] {
            let fixture = Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("fixtures")
                .join(file);
            let result = engine
                .outline(
                    OutlineTarget::File {
                        path: fixture.to_string_lossy().into_owned(),
                        language,
                    },
                    false,
                    &[],
                )
                .expect("public fixture outline should parse");
            assert!(
                result.files[0]
                    .items
                    .iter()
                    .all(|item| item.entry.name != private_name),
                "{file} exposed {private_name}"
            );
        }

        let go = outline_file(
            &engine,
            &Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/go.go"),
            LanguageId::Go,
        );
        let file_parser = go
            .items
            .iter()
            .find(|item| item.entry.name == "FileParser")
            .expect("Go fixture should contain FileParser");
        assert!(
            file_parser
                .members
                .iter()
                .any(|member| member.entry.name == "source" && !member.is_public)
        );
    }

    #[test]
    fn retrieves_exact_symbol_source_and_rejects_stale_locator() {
        let engine = OutlineEngine::new().expect("outline rules should compile");
        let fixture = Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/typescript.ts");
        let source = fs::read_to_string(&fixture).expect("fixture should be readable");
        let temporary =
            std::env::temp_dir().join(format!("tau-ast-symbol-fixture-{}.ts", std::process::id()));
        fs::write(&temporary, &source).expect("temporary fixture should be writable");

        let result = outline_file(&engine, &temporary, LanguageId::TypeScript);
        let item = result
            .items
            .iter()
            .find(|item| item.entry.name == "FileParser")
            .expect("fixture should contain FileParser");
        let symbol = engine
            .symbol(std::slice::from_ref(&item.entry.locator), 0)
            .expect("fresh locator should resolve");

        assert_eq!(
            symbol.blocks[0].source,
            source[item.entry.range.start_byte..item.entry.range.end_byte]
        );
        assert_eq!(
            symbol.declarations[0].source_fingerprint,
            result.source_fingerprint
        );

        fs::write(&temporary, format!("// changed\n{source}"))
            .expect("temporary fixture should be mutable");
        let error = engine
            .symbol(std::slice::from_ref(&item.entry.locator), 0)
            .expect_err("changed source should make the locator stale");
        assert_eq!(error.code, "stale_locator");

        fs::remove_file(temporary).expect("temporary fixture should be removable");
    }

    #[test]
    fn outlines_sorted_non_recursive_typescript_directories() {
        let engine = OutlineEngine::new().expect("outline rules should compile");
        let temporary =
            std::env::temp_dir().join(format!("tau-ast-directory-fixture-{}", std::process::id()));
        let nested = temporary.join("nested");
        fs::create_dir_all(&nested).expect("temporary directory should be writable");
        fs::write(temporary.join("b.tsx"), "export const B = () => <div />;\n")
            .expect("TSX fixture should be writable");
        fs::write(temporary.join("a.ts"), "export const A = 1;\n")
            .expect("TypeScript fixture should be writable");
        fs::write(nested.join("ignored.ts"), "export const ignored = true;\n")
            .expect("nested fixture should be writable");

        let result = engine
            .outline(
                OutlineTarget::Directory {
                    path: temporary.to_string_lossy().into_owned(),
                },
                true,
                &[],
            )
            .expect("TypeScript and TSX should share one language family");

        assert_eq!(result.files.len(), 2);
        assert!(result.files[0].path.ends_with("a.ts"));
        assert!(result.files[1].path.ends_with("b.tsx"));
        assert_eq!(
            result.total_byte_length,
            result
                .files
                .iter()
                .map(|file| file.byte_length)
                .sum::<usize>()
        );
        assert_eq!(
            result.total_line_count,
            result
                .files
                .iter()
                .map(|file| file.line_count)
                .sum::<usize>()
        );

        fs::remove_dir_all(temporary).expect("temporary directory should be removable");
    }

    #[test]
    fn rejects_empty_and_mixed_language_directories() {
        let engine = OutlineEngine::new().expect("outline rules should compile");
        let temporary = std::env::temp_dir().join(format!(
            "tau-ast-invalid-directory-fixture-{}",
            std::process::id()
        ));
        fs::create_dir_all(&temporary).expect("temporary directory should be writable");
        fs::write(temporary.join("README.md"), "empty\n")
            .expect("unsupported fixture should be writable");
        let empty_error = engine
            .outline(
                OutlineTarget::Directory {
                    path: temporary.to_string_lossy().into_owned(),
                },
                true,
                &[],
            )
            .expect_err("directory without supported files should fail");
        assert!(
            empty_error
                .to_string()
                .contains("no supported source files")
        );

        fs::write(temporary.join("one.ts"), "export const one = 1;\n")
            .expect("TypeScript fixture should be writable");
        fs::write(temporary.join("two.go"), "package sample\n")
            .expect("Go fixture should be writable");
        let mixed_error = engine
            .outline(
                OutlineTarget::Directory {
                    path: temporary.to_string_lossy().into_owned(),
                },
                true,
                &[],
            )
            .expect_err("mixed-language directory should fail");
        assert!(
            mixed_error
                .to_string()
                .contains("mixed supported language families")
        );

        fs::remove_dir_all(temporary).expect("temporary directory should be removable");
    }
}
