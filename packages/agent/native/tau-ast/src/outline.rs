use crate::go::{extract_go_items, filter_go_items, finalize_go_signatures, matching_go_imports};
use crate::java::{
    extract_java_items, filter_java_items, finalize_java_signatures, matching_java_imports,
};
use crate::language::OdinLanguage;
use crate::rust::{
    extract_rust_items, filter_rust_items, finalize_rust_signatures, matching_rust_imports,
};
use crate::typescript::{
    extract_typescript_items, filter_typescript_items, finalize_typescript_signatures,
};
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

const LOCATOR_VERSION: u32 = 2;

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

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum EntryRole {
    Item,
    Member,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
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

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutlineEntry {
    pub role: EntryRole,
    pub symbol_type: SymbolType,
    pub name: String,
    pub qualified_name: String,
    pub range: SourceRange,
    pub name_range: SourceRange,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub receiver_range: Option<SourceRange>,
    pub body_range: Option<SourceRange>,
    pub signature: String,
    pub ast_kind: String,
    pub certainty: ParseCertainty,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub certainty_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub locator: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ParseCertainty {
    Certain,
    Recovered,
    NearRecovery,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutlineItem {
    #[serde(flatten)]
    pub entry: OutlineEntry,
    pub row_kind: OutlineRowKind,
    pub is_import: bool,
    pub is_exported: bool,
    pub members: Vec<OutlineMember>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum OutlineRowKind {
    Package,
    Import,
    Declaration,
    Export,
    SideEffect,
}

#[derive(Clone, Debug, Serialize)]
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

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SymbolView {
    Signature,
    Declaration,
    DeclarationWithImports,
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
    locator_kind: LocatorKind,
    qualified_name: String,
    declaration_kind: String,
    range: SourceRange,
    name_range: SourceRange,
    receiver_range: Option<SourceRange>,
    body_range: Option<SourceRange>,
    certainty: ParseCertainty,
    signature: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
enum LocatorKind {
    Declaration,
    ExecutableScope,
}

pub struct OutlineEngine {
    c_sharp: CombinedExtractors<SupportLang>,
    kotlin: CombinedExtractors<SupportLang>,
    swift: CombinedExtractors<SupportLang>,
    odin: CombinedExtractors<OdinLanguage>,
}

impl OutlineEngine {
    pub fn new() -> Result<Self, Box<dyn Error>> {
        let default_rules = parse_outline_rules::<SupportLang>(DEFAULT_OUTLINE_RULES)?;
        let c_sharp_rules = default_rules
            .iter()
            .filter(|rule| rule.common().language == SupportLang::CSharp)
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
            c_sharp: CombinedExtractors::try_from(c_sharp_rules, &globals)?,
            kotlin: CombinedExtractors::try_from(kotlin_rules, &globals)?,
            swift: CombinedExtractors::try_from(swift_rules, &globals)?,
            odin: CombinedExtractors::try_from(odin_rules, &globals)?,
        })
    }

    pub fn outline(
        &self,
        target: OutlineTarget,
        include_private: bool,
        include_docs: bool,
        names: &[String],
    ) -> Result<OutlineTargetResult, Box<dyn Error>> {
        let (path, mut files) = match target {
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
                let file =
                    self.outline_file(&path, language, include_private, include_docs, names)?;
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
                        self.outline_file(
                            &file_path,
                            language,
                            include_private,
                            include_docs,
                            names,
                        )
                    })
                    .collect::<Result<Vec<_>, _>>()?;
                (path, files)
            }
        };
        let total_byte_length = files.iter().map(|file| file.byte_length).sum();
        let total_line_count = files.iter().map(|file| file.line_count).sum();
        if !names.is_empty() {
            files.retain(|file| {
                file.items
                    .iter()
                    .any(|item| item.row_kind == OutlineRowKind::Declaration)
            });
        }

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
        include_docs: bool,
        names: &[String],
    ) -> Result<OutlineFileResult, Box<dyn Error>> {
        let source_bytes = fs::read(path)?;
        let source = str::from_utf8(&source_bytes)?;
        let path = path.to_string_lossy().into_owned();
        let source_fingerprint = source_fingerprint(&source_bytes);
        let (diagnostics, mut items, directly_filtered) = match language {
            LanguageId::TypeScript => {
                let grep = SupportLang::TypeScript.ast_grep(source);
                let diagnostics = diagnostics(grep.root());
                let mut items = extract_typescript_items(grep.root(), source, include_docs);
                filter_typescript_items(grep.root(), &mut items, include_private, names);
                (diagnostics, items, true)
            }
            LanguageId::Tsx => {
                let grep = SupportLang::Tsx.ast_grep(source);
                let diagnostics = diagnostics(grep.root());
                let mut items = extract_typescript_items(grep.root(), source, include_docs);
                filter_typescript_items(grep.root(), &mut items, include_private, names);
                (diagnostics, items, true)
            }
            LanguageId::Odin => {
                let grep = OdinLanguage::Odin.ast_grep(source);
                (
                    diagnostics(grep.root()),
                    self.odin
                        .extract(grep.root())
                        .map(|item| outline_item(item, &path, language, &source_fingerprint))
                        .collect::<Result<Vec<_>, _>>()?,
                    false,
                )
            }
            LanguageId::Go => {
                let grep = SupportLang::Go.ast_grep(source);
                let diagnostics = diagnostics(grep.root());
                let mut items = extract_go_items(grep.root(), source, include_docs);
                filter_go_items(grep.root(), source, &mut items, include_private, names);
                (diagnostics, items, true)
            }
            LanguageId::Rust => {
                let grep = SupportLang::Rust.ast_grep(source);
                let diagnostics = diagnostics(grep.root());
                let mut items = extract_rust_items(grep.root(), source, include_docs);
                filter_rust_items(grep.root(), source, &mut items, include_private, names);
                (diagnostics, items, true)
            }
            LanguageId::CSharp => {
                let grep = SupportLang::CSharp.ast_grep(source);
                (
                    diagnostics(grep.root()),
                    self.c_sharp
                        .extract(grep.root())
                        .map(|item| outline_item(item, &path, language, &source_fingerprint))
                        .collect::<Result<Vec<_>, _>>()?,
                    false,
                )
            }
            LanguageId::Java => {
                let grep = SupportLang::Java.ast_grep(source);
                let diagnostics = diagnostics(grep.root());
                let mut items = extract_java_items(grep.root(), source, include_docs);
                filter_java_items(grep.root(), source, &mut items, include_private, names);
                (diagnostics, items, true)
            }
            LanguageId::Kotlin => {
                let grep = SupportLang::Kotlin.ast_grep(source);
                (
                    diagnostics(grep.root()),
                    self.kotlin
                        .extract(grep.root())
                        .map(|item| outline_item(item, &path, language, &source_fingerprint))
                        .collect::<Result<Vec<_>, _>>()?,
                    false,
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
                    false,
                )
            }
        };
        let line_count = if source.is_empty() {
            0
        } else {
            source.bytes().filter(|byte| *byte == b'\n').count() + 1
        };
        if !directly_filtered {
            filter_items(&mut items, include_private, names);
        }
        if matches!(
            language,
            LanguageId::TypeScript
                | LanguageId::Tsx
                | LanguageId::Go
                | LanguageId::Rust
                | LanguageId::Java
        ) {
            match language {
                LanguageId::Go => finalize_go_signatures(&mut items),
                LanguageId::Rust => finalize_rust_signatures(&mut items),
                LanguageId::Java => finalize_java_signatures(&mut items),
                _ => finalize_typescript_signatures(&mut items),
            }
            finalize_locators(&mut items, &path, language, &source_fingerprint)?;
        }

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
        view: SymbolView,
        context_lines: usize,
    ) -> Result<SymbolBatchResult, SymbolError> {
        if context_lines > 0 && !matches!(view, SymbolView::Declaration) {
            return Err(SymbolError {
                code: "unsupported_symbol_view",
                message: "contextLines is supported only with the declaration view".to_owned(),
            });
        }
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

        if !matches!(view, SymbolView::Declaration)
            && locators.iter().any(|(_, locator)| {
                !matches!(
                    locator.language,
                    LanguageId::TypeScript
                        | LanguageId::Tsx
                        | LanguageId::Go
                        | LanguageId::Rust
                        | LanguageId::Java
                )
            })
        {
            return Err(SymbolError {
                code: "unsupported_symbol_view",
                message: "signature and declarationWithImports views support TypeScript, TSX, Go, Rust, and Java only"
                    .to_owned(),
            });
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
            let selected_range = locator.range.clone();
            source
                .get(selected_range.start_byte..selected_range.end_byte)
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
            let selected = locator.range.clone();
            let (start_byte, end_byte) = if matches!(view, SymbolView::Signature) {
                (selected.start_byte, selected.end_byte)
            } else {
                padded_range(source.as_bytes(), &selected, context_lines)
            };
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
                let block_source = if matches!(view, SymbolView::Signature) {
                    declaration_indexes
                        .iter()
                        .map(|index| locators[*index].1.signature.as_str())
                        .collect::<Vec<_>>()
                        .join("\n\n")
                } else if matches!(view, SymbolView::DeclarationWithImports) {
                    declaration_indexes
                        .iter()
                        .map(|index| declaration_with_imports(source, &locators[*index].1))
                        .collect::<Vec<_>>()
                        .join("\n\n")
                } else {
                    source[start_byte..end_byte].to_owned()
                };
                Ok(SymbolBlock {
                    path,
                    returned_range: source_range(source.as_bytes(), start_byte, end_byte),
                    declaration_indexes,
                    source: block_source,
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
            item.is_import
                || item.row_kind == OutlineRowKind::Package
                || include_private
                || item.is_exported
        });
        return;
    }
    items.retain_mut(|item| {
        if item.is_import || item.row_kind == OutlineRowKind::Package {
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
    let row_kind = if item.is_import {
        OutlineRowKind::Import
    } else {
        OutlineRowKind::Declaration
    };
    let mut entry = outline_entry(item.entry, path, language, source_fingerprint)?;
    if row_kind != OutlineRowKind::Declaration {
        entry.locator = None;
    }
    Ok(OutlineItem {
        entry,
        row_kind,
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
        locator_kind: LocatorKind::Declaration,
        qualified_name: entry.name.to_string(),
        declaration_kind: entry.ast_kind.to_string(),
        range: range.clone(),
        name_range: range.clone(),
        receiver_range: None,
        body_range: None,
        certainty: ParseCertainty::Certain,
        signature: entry.signature.to_string(),
    };

    Ok(OutlineEntry {
        role: match entry.role {
            AstEntryRole::Item => EntryRole::Item,
            AstEntryRole::Member => EntryRole::Member,
        },
        symbol_type: entry.symbol_type.into(),
        name: entry.name.clone().into_owned(),
        qualified_name: entry.name.into_owned(),
        name_range: range.clone(),
        receiver_range: None,
        body_range: None,
        certainty: ParseCertainty::Certain,
        certainty_reason: None,
        range,
        signature: entry.signature.into_owned(),
        ast_kind: entry.ast_kind.into_owned(),
        locator: Some(URL_SAFE_NO_PAD.encode(serde_json::to_vec(&locator)?)),
    })
}

fn finalize_locators(
    items: &mut [OutlineItem],
    path: &str,
    language: LanguageId,
    source_fingerprint: &str,
) -> Result<(), serde_json::Error> {
    for item in items {
        if item.row_kind != OutlineRowKind::Declaration {
            item.entry.locator = None;
            continue;
        }
        item.entry.locator = Some(encode_locator(
            &item.entry,
            path,
            language,
            source_fingerprint,
        )?);
        for member in &mut item.members {
            member.entry.locator = Some(encode_locator(
                &member.entry,
                path,
                language,
                source_fingerprint,
            )?);
        }
    }
    Ok(())
}

fn encode_locator(
    entry: &OutlineEntry,
    path: &str,
    language: LanguageId,
    source_fingerprint: &str,
) -> Result<String, serde_json::Error> {
    Ok(URL_SAFE_NO_PAD.encode(serde_json::to_vec(&SourceLocator {
        version: LOCATOR_VERSION,
        path: path.to_owned(),
        language,
        source_fingerprint: source_fingerprint.to_owned(),
        locator_kind: LocatorKind::Declaration,
        qualified_name: entry.qualified_name.clone(),
        declaration_kind: entry.ast_kind.clone(),
        range: entry.range.clone(),
        name_range: entry.name_range.clone(),
        receiver_range: entry.receiver_range.clone(),
        body_range: entry.body_range.clone(),
        certainty: entry.certainty,
        signature: entry.signature.clone(),
    })?))
}

fn declaration_with_imports(source: &str, locator: &SourceLocator) -> String {
    let declaration = &source[locator.range.start_byte..locator.range.end_byte];
    let imports = match locator.language {
        LanguageId::TypeScript => {
            let grep = SupportLang::TypeScript.ast_grep(source);
            matching_imports(grep.root(), source, locator)
        }
        LanguageId::Tsx => {
            let grep = SupportLang::Tsx.ast_grep(source);
            matching_imports(grep.root(), source, locator)
        }
        LanguageId::Go => {
            let grep = SupportLang::Go.ast_grep(source);
            matching_go_imports(grep.root(), source, &locator.range)
        }
        LanguageId::Rust => {
            let grep = SupportLang::Rust.ast_grep(source);
            matching_rust_imports(grep.root(), source, &locator.range)
        }
        LanguageId::Java => {
            let grep = SupportLang::Java.ast_grep(source);
            matching_java_imports(grep.root(), source, &locator.range)
        }
        _ => Vec::new(),
    };
    if imports.is_empty() {
        return declaration.to_owned();
    }
    format!("{}\n\n{declaration}", imports.join("\n"))
}

fn matching_imports<'a, D: ast_grep_core::Doc>(
    root: Node<D>,
    source: &'a str,
    locator: &SourceLocator,
) -> Vec<&'a str> {
    let locally_bound_names = root
        .dfs()
        .filter(|node| {
            let node_range = node.range();
            node_range.start >= locator.range.start_byte && node_range.end <= locator.range.end_byte
        })
        .filter_map(|node| match node.kind().as_ref() {
            "required_parameter"
            | "optional_parameter"
            | "variable_declarator"
            | "type_parameter" => node.field("name").map(|name| name.text().into_owned()),
            _ => None,
        })
        .collect::<BTreeSet<_>>();
    let used_names = root
        .dfs()
        .filter(|node| {
            let node_range = node.range();
            node_range.start >= locator.range.start_byte
                && node_range.end <= locator.range.end_byte
                && matches!(node.kind().as_ref(), "identifier" | "type_identifier")
        })
        .map(|node| node.text().into_owned())
        .filter(|name| !locally_bound_names.contains(name))
        .collect::<BTreeSet<_>>();

    root.children()
        .filter(|node| node.kind() == "import_statement")
        .filter_map(|import| {
            let bindings = import
                .dfs()
                .filter_map(|node| match node.kind().as_ref() {
                    "import_specifier" => node
                        .field("alias")
                        .or_else(|| node.field("name"))
                        .map(|name| name.text().into_owned()),
                    "identifier"
                        if node.parent().is_some_and(|parent| {
                            matches!(parent.kind().as_ref(), "import_clause" | "namespace_import")
                        }) =>
                    {
                        Some(node.text().into_owned())
                    }
                    _ => None,
                })
                .collect::<BTreeSet<_>>();
            bindings
                .iter()
                .any(|name| used_names.contains(name))
                .then(|| {
                    let import_range = import.range();
                    &source[import_range.start..import_range.end]
                })
        })
        .collect()
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
                .filter(|item| item.row_kind == OutlineRowKind::Declaration)
                .all(|item| item
                    .entry
                    .locator
                    .as_ref()
                    .is_some_and(|locator| !locator.is_empty()))
        );
    }

    #[test]
    fn extracts_complete_typescript_declarations_and_selective_views() {
        let engine = OutlineEngine::new().expect("outline rules should compile");
        let fixture = Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/typescript-complete.ts");
        let source = fs::read_to_string(&fixture).expect("fixture should be readable");
        let public = engine
            .outline(
                OutlineTarget::File {
                    path: fixture.to_string_lossy().into_owned(),
                    language: LanguageId::TypeScript,
                },
                false,
                true,
                &[],
            )
            .expect("fixture should parse")
            .files
            .into_iter()
            .next()
            .expect("file target should return one file");

        assert_eq!(public.diagnostics.error_nodes, 0);
        assert_eq!(public.diagnostics.missing_nodes, 0);
        assert_eq!(public.items[0].row_kind, OutlineRowKind::Import);
        assert_eq!(public.items[1].row_kind, OutlineRowKind::Import);
        assert!(public.items[0].entry.locator.is_none());
        assert!(
            public
                .items
                .iter()
                .any(|item| item.row_kind == OutlineRowKind::SideEffect
                    && item.entry.name == "call registerService(...)")
        );
        assert!(public.items.iter().any(|item| {
            item.row_kind == OutlineRowKind::Export
                && item.entry.signature == "export { makeService as createService };"
                && item.entry.locator.is_none()
        }));

        let overloads = public
            .items
            .iter()
            .filter(|item| item.entry.name == "refresh")
            .collect::<Vec<_>>();
        assert_eq!(overloads.len(), 3);
        assert!(
            overloads[0]
                .entry
                .signature
                .contains("@deprecated Use refreshMany.")
        );
        assert!(overloads[0].entry.body_range.is_none());
        assert!(overloads[1].entry.body_range.is_none());
        let implementation = overloads[2];
        let implementation_body = implementation
            .entry
            .body_range
            .as_ref()
            .expect("implementation should expose its body");
        assert_eq!(
            &source[implementation_body.start_byte..implementation_body.end_byte],
            "{\n\treturn Promise.resolve({ value });\n}"
        );
        assert_eq!(
            overloads
                .iter()
                .filter_map(|item| item.entry.locator.as_ref())
                .collect::<BTreeSet<_>>()
                .len(),
            3
        );

        let ambient = public
            .items
            .iter()
            .find(|item| item.entry.name == "ambient")
            .expect("ambient declaration should be extracted");
        assert_eq!(
            &source[ambient.entry.range.start_byte..ambient.entry.range.end_byte],
            "export declare function ambient(value: Input): Output;"
        );

        let service = public
            .items
            .iter()
            .find(|item| item.entry.name == "Service")
            .expect("abstract class should be extracted");
        assert!(
            service
                .entry
                .signature
                .starts_with("@sealed\nexport abstract class")
        );
        assert!(!service.entry.signature.contains("protected cache"));
        assert!(!service.entry.signature.contains("return true"));
        assert!(
            service
                .members
                .iter()
                .any(|member| member.entry.symbol_type == SymbolType::Constructor)
        );
        assert!(
            service
                .members
                .iter()
                .any(|member| member.entry.name == "run" && member.entry.body_range.is_none())
        );
        assert!(
            service
                .members
                .iter()
                .any(|member| member.entry.name == "callback" && member.entry.body_range.is_some())
        );

        let mapper = public
            .items
            .iter()
            .find(|item| item.entry.name == "Mapper")
            .expect("multiline type alias should be extracted");
        assert_eq!(
            mapper.entry.signature,
            "export type Mapper<T extends Input = Input> = (\n    _value: T,\n) => Promise<Output>;"
        );
        let make_service = public
            .items
            .iter()
            .find(|item| item.entry.name == "makeService")
            .expect("callable variable should be extracted");
        assert_eq!(
            make_service.entry.signature,
            "export const makeService = <T extends Input>(_value: T): Service<T> => …"
        );
        assert_eq!(
            service
                .members
                .iter()
                .find(|member| member.entry.name == "callback")
                .expect("callback property should be extracted")
                .entry
                .signature,
            "callback = (value: T): T => …"
        );
        assert!(
            source[make_service.entry.range.start_byte..make_service.entry.range.end_byte]
                .starts_with("export const makeService")
        );
        assert!(
            source[make_service.entry.range.start_byte..make_service.entry.range.end_byte]
                .ends_with(';')
        );

        let with_imports = engine
            .symbol(
                std::slice::from_ref(
                    implementation
                        .entry
                        .locator
                        .as_ref()
                        .expect("implementation should have a locator"),
                ),
                SymbolView::DeclarationWithImports,
                0,
            )
            .expect("declaration-with-imports should resolve");
        assert!(
            with_imports.blocks[0]
                .source
                .contains("import type {\n    Input,\n    Output,")
        );
        assert!(!with_imports.blocks[0].source.contains("unused"));

        let filtered = engine
            .outline(
                OutlineTarget::File {
                    path: fixture.to_string_lossy().into_owned(),
                    language: LanguageId::TypeScript,
                },
                false,
                true,
                &["refresh".to_owned()],
            )
            .expect("filtered fixture should parse");
        assert_eq!(
            filtered.files[0]
                .items
                .iter()
                .filter(|item| item.row_kind == OutlineRowKind::Declaration)
                .count(),
            3
        );
        assert_eq!(
            filtered.files[0]
                .items
                .iter()
                .filter(|item| item.row_kind == OutlineRowKind::Import)
                .count(),
            1
        );
        assert!(
            !filtered.files[0]
                .items
                .iter()
                .any(|item| item.row_kind == OutlineRowKind::SideEffect)
        );

        let filtered_service = engine
            .outline(
                OutlineTarget::File {
                    path: fixture.to_string_lossy().into_owned(),
                    language: LanguageId::TypeScript,
                },
                false,
                true,
                &["Service".to_owned()],
            )
            .expect("top-level class filter should parse");
        let filtered_service = filtered_service.files[0]
            .items
            .iter()
            .find(|item| item.entry.name == "Service")
            .expect("top-level class match should remain");
        assert!(
            filtered_service
                .members
                .iter()
                .any(|member| member.entry.name == "callback")
        );
        assert!(
            filtered_service
                .members
                .iter()
                .all(|member| member.entry.name != "cache")
        );
    }

    #[test]
    fn documentation_is_opt_in_without_changing_exact_declaration_ranges() {
        let engine = OutlineEngine::new().expect("outline rules should compile");
        let cases = [
            (
                LanguageId::TypeScript,
                "ts",
                "/** Service docs. */\n@sealed\nexport class Service {\n  /** Run docs. */\n  @logged\n  run(): void {}\n}\n\nexport const marker = \"/** keep */\";\n",
                "Service",
                "run",
                "@sealed",
                "@logged",
            ),
            (
                LanguageId::Go,
                "go",
                "package docs\n\n/* Service docs.\n//go:noescape\n*/\n/*line generated.go:10*/\n//go:noinline\ntype Service struct {\n\t// Run docs.\n\tRun func()\n}\n",
                "Service",
                "Run",
                "//go:noinline",
                "Run func()",
            ),
            (
                LanguageId::Rust,
                "rs",
                "/// Service docs.\n#[derive(Debug)]\n// Attribute explanation.\npub struct Service {\n    /// Run docs.\n    #[cfg(test)]\n    pub run: fn(),\n}\n\n/// Tuple docs.\npub struct Tuple(\n    /// Field docs.\n    #[cfg(test)]\n    pub u8,\n);\n",
                "Service",
                "run",
                "#[derive(Debug)]",
                "#[cfg(test)]",
            ),
            (
                LanguageId::Java,
                "java",
                "/** Service docs. */\n@Deprecated\npublic class Service {\n    /** Run docs. */\n    @Deprecated\n    public void run() {}\n}\n",
                "Service",
                "run",
                "@Deprecated",
                "@Deprecated",
            ),
        ];

        for (
            language,
            extension,
            source,
            item_name,
            member_name,
            item_attribute,
            member_attribute,
        ) in cases
        {
            let path = std::env::temp_dir().join(format!(
                "tau-ast-docs-{}-{extension}.{extension}",
                std::process::id()
            ));
            fs::write(&path, source).expect("documentation fixture should be writable");
            let target = OutlineTarget::File {
                path: path.to_string_lossy().into_owned(),
                language,
            };

            let default = engine
                .outline(target, true, false, &[])
                .expect("default outline should parse");
            let item = default.files[0]
                .items
                .iter()
                .find(|item| item.entry.name == item_name)
                .expect("top-level declaration should remain");
            let member = item
                .members
                .iter()
                .find(|member| member.entry.name == member_name)
                .expect("member declaration should remain");
            assert!(
                !item.entry.signature.contains("Service docs."),
                "{extension}"
            );
            assert!(!member.entry.signature.contains("Run docs."), "{extension}");
            assert!(item.entry.signature.contains(item_attribute), "{extension}");
            assert!(
                member.entry.signature.contains(member_attribute),
                "{extension}"
            );
            if language == LanguageId::Go {
                assert!(item.entry.signature.contains("/*line generated.go:10*/"));
                assert!(!item.entry.signature.contains("//go:noescape"));
            }
            assert!(
                source[item.entry.range.start_byte..item.entry.range.end_byte]
                    .trim_start()
                    .starts_with(if language == LanguageId::Go {
                        "/* Service docs."
                    } else if language == LanguageId::Rust {
                        "/// Service docs."
                    } else {
                        "/** Service docs. */"
                    }),
                "{extension}"
            );
            let exact = engine
                .symbol(
                    std::slice::from_ref(
                        member
                            .entry
                            .locator
                            .as_ref()
                            .expect("member should have a locator"),
                    ),
                    SymbolView::Declaration,
                    0,
                )
                .expect("exact member declaration should resolve");
            assert!(exact.blocks[0].source.contains("Run docs."), "{extension}");

            let documented = engine
                .outline(
                    OutlineTarget::File {
                        path: path.to_string_lossy().into_owned(),
                        language,
                    },
                    true,
                    true,
                    &[],
                )
                .expect("documented outline should parse");
            let documented_item = documented.files[0]
                .items
                .iter()
                .find(|item| item.entry.name == item_name)
                .expect("documented item should remain");
            assert!(documented_item.entry.signature.contains("Service docs."));
            assert!(
                documented_item
                    .members
                    .iter()
                    .find(|member| member.entry.name == member_name)
                    .is_some_and(|member| member.entry.signature.contains("Run docs."))
            );

            let filtered = engine
                .outline(
                    OutlineTarget::File {
                        path: path.to_string_lossy().into_owned(),
                        language,
                    },
                    true,
                    false,
                    &[member_name.to_owned()],
                )
                .expect("name-filtered outline should parse");
            let filtered_item = filtered.files[0]
                .items
                .iter()
                .find(|item| item.entry.name == item_name)
                .expect("member owner should remain after filtering");
            assert_eq!(filtered_item.members.len(), 1, "{extension}");
            assert!(
                !filtered_item.members[0]
                    .entry
                    .signature
                    .contains("Run docs.")
            );
            assert!(
                filtered_item.members[0]
                    .entry
                    .signature
                    .contains(member_attribute),
                "{extension}"
            );

            if language == LanguageId::TypeScript {
                let marker = default.files[0]
                    .items
                    .iter()
                    .find(|item| item.entry.name == "marker")
                    .expect("string-valued declaration should remain");
                assert!(marker.entry.signature.contains("/** keep */"));
            }
            if language == LanguageId::Rust {
                let tuple = default.files[0]
                    .items
                    .iter()
                    .find(|item| item.entry.name == "Tuple")
                    .expect("tuple struct should remain");
                assert!(!tuple.members[0].entry.signature.contains("Field docs."));
                assert!(tuple.members[0].entry.signature.contains("#[cfg(test)]"));
            }

            fs::remove_file(path).expect("documentation fixture should be removable");
        }
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
                &["Parser", "Pair", "FileParser", "create_parser"],
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
                .find(|item| item.row_kind == OutlineRowKind::Declaration)
                .expect("fixture should contain a declaration");
            let symbol = engine
                .symbol(
                    std::slice::from_ref(
                        item.entry
                            .locator
                            .as_ref()
                            .expect("declaration should have a locator"),
                    ),
                    SymbolView::Declaration,
                    0,
                )
                .expect("fresh locator should resolve");
            assert_eq!(
                symbol.blocks[0].source,
                source[item.entry.range.start_byte..item.entry.range.end_byte],
                "{file}"
            );
        }
    }

    #[test]
    fn extracts_complete_go_declarations_ranges_and_selective_views() {
        let engine = OutlineEngine::new().expect("outline rules should compile");
        let fixture = Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/go.go");
        let source = fs::read_to_string(&fixture).expect("fixture should be readable");
        let result = outline_file(&engine, &fixture, LanguageId::Go);

        assert_eq!(result.diagnostics.error_nodes, 0);
        assert_eq!(result.diagnostics.missing_nodes, 0);
        assert_eq!(result.items[0].row_kind, OutlineRowKind::Package);
        assert_eq!(result.items[0].entry.name, "fixture");
        assert_eq!(
            &source[result.items[0].entry.name_range.start_byte
                ..result.items[0].entry.name_range.end_byte],
            "fixture"
        );
        assert_eq!(result.items[1].row_kind, OutlineRowKind::Import);
        assert!(result.items[0].entry.locator.is_none());
        assert!(result.items[1].entry.locator.is_none());

        let default_limit = result
            .items
            .iter()
            .find(|item| item.entry.name == "DefaultLimit")
            .expect("grouped constant should be extracted");
        assert!(default_limit.entry.signature.starts_with("// DefaultLimit"));
        assert!(
            source[default_limit.entry.range.start_byte..default_limit.entry.range.end_byte]
                .contains("const (\n\tDefaultLimit = 10")
        );
        let hidden_limit = result
            .items
            .iter()
            .find(|item| item.entry.name == "hiddenLimit")
            .expect("private grouped constant should be extracted");
        assert!(hidden_limit.entry.signature.starts_with("// hiddenLimit"));
        let inherited_limit = result
            .items
            .iter()
            .find(|item| item.entry.name == "InheritedLimit")
            .expect("inherited constant should be extracted");
        assert!(
            inherited_limit
                .entry
                .signature
                .ends_with("= … // inherited")
        );
        let handler = result
            .items
            .iter()
            .find(|item| item.entry.name == "Handler")
            .expect("callable variable should be extracted");
        assert_eq!(
            handler.entry.signature,
            "var Handler        = func() string { … }"
        );
        assert!(!handler.entry.signature.contains("hidden body"));
        assert!(handler.entry.body_range.is_some());
        assert!(
            !result
                .items
                .iter()
                .any(|item| item.entry.name == "ExportedLocal")
        );
        let handlers = result
            .items
            .iter()
            .find(|item| item.entry.name == "Handlers")
            .expect("multiple callable initializers should be extracted");
        assert_eq!(handlers.entry.signature.matches("{ … }").count(), 2);
        assert!(!handlers.entry.signature.contains("first body"));
        assert!(!handlers.entry.signature.contains("second body"));
        assert!(handlers.entry.body_range.is_none());

        let alias = result
            .items
            .iter()
            .find(|item| item.entry.name == "Value")
            .expect("type alias should be extracted");
        assert_eq!(alias.entry.signature, "type Value = string");
        assert!(alias.entry.body_range.is_none());
        let grouped = result
            .items
            .iter()
            .find(|item| item.entry.name == "Grouped")
            .expect("grouped type should be extracted");
        assert!(grouped.entry.signature.starts_with("// Grouped documents"));

        let pair = result
            .items
            .iter()
            .find(|item| item.entry.name == "Pair")
            .expect("generic struct should be extracted");
        assert!(
            pair.entry
                .signature
                .starts_with("type Pair[T comparable] struct {")
        );
        assert!(pair.entry.signature.contains("Left T"));
        assert!(pair.entry.signature.contains("Right T"));
        assert_eq!(
            pair.members
                .iter()
                .map(|member| member.entry.name.as_str())
                .collect::<Vec<_>>(),
            ["Left", "Right", "Result", "Box"]
        );
        let pair_body = pair
            .entry
            .body_range
            .as_ref()
            .expect("struct should have a body");
        assert_eq!(
            &source[pair_body.start_byte..pair_body.end_byte],
            "{\n\tLeft, Right T\n\t*Result\n\tBox[string]\n}"
        );

        let parser = result
            .items
            .iter()
            .find(|item| item.entry.name == "Parser")
            .expect("interface should be extracted");
        assert!(parser.entry.signature.contains("type Parser interface {"));
        assert!(
            parser
                .members
                .iter()
                .any(|member| member.entry.name == "~int | ~string")
        );

        let method = result
            .items
            .iter()
            .find(|item| item.entry.qualified_name == "FileParser.Parse")
            .expect("pointer receiver method should be extracted");
        assert_eq!(method.entry.role, EntryRole::Member);
        assert!(!method.entry.signature.contains("stringsAlias.TrimSpace"));
        let receiver = method
            .entry
            .receiver_range
            .as_ref()
            .expect("method should have a receiver range");
        assert_eq!(
            &source[receiver.start_byte..receiver.end_byte],
            "(parser *FileParser)"
        );
        let body = method
            .entry
            .body_range
            .as_ref()
            .expect("method should have a body");
        assert!(source[body.start_byte..body.end_byte].starts_with('{'));
        assert!(result.items.iter().any(|item| item.entry.name == "init"));

        let signature = engine
            .symbol(
                std::slice::from_ref(
                    method
                        .entry
                        .locator
                        .as_ref()
                        .expect("method should have a locator"),
                ),
                SymbolView::Signature,
                0,
            )
            .expect("Go signature should resolve");
        assert_eq!(signature.blocks[0].source, method.entry.signature);

        let filtered = engine
            .outline(
                OutlineTarget::File {
                    path: fixture.to_string_lossy().into_owned(),
                    language: LanguageId::Go,
                },
                false,
                true,
                &["Parser".to_owned()],
            )
            .expect("Go container filter should resolve");
        let filtered_parser = filtered.files[0]
            .items
            .iter()
            .find(|item| item.entry.name == "Parser")
            .expect("filtered interface should remain");
        assert_eq!(filtered.files[0].items[0].row_kind, OutlineRowKind::Package);
        assert!(
            filtered_parser
                .members
                .iter()
                .any(|member| member.entry.name == "Parse")
        );
        assert!(
            filtered_parser
                .members
                .iter()
                .any(|member| member.entry.name == "~int | ~string")
        );
    }

    #[test]
    fn handles_go_import_modes_utf8_crlf_and_recovery() {
        let engine = OutlineEngine::new().expect("outline rules should compile");
        let imports_path =
            std::env::temp_dir().join(format!("tau-ast-go-imports-{}.go", std::process::id()));
        let imports_source = r#"package fixture

import "fmt"
import alias "strings"
import . "math"
import _ "embed"
import unused "bytes"
import "math/rand/v2"

func Render(source string) string {
	fmt.Println(Sqrt(4))
	fmt.Println(rand.Int())
	return alias.TrimSpace(source)
}
"#;
        fs::write(&imports_path, imports_source).expect("Go import fixture should be writable");
        let imports = outline_file(&engine, &imports_path, LanguageId::Go);
        let render = imports
            .items
            .iter()
            .find(|item| item.entry.name == "Render")
            .expect("Go function should be extracted");
        let with_imports = engine
            .symbol(
                std::slice::from_ref(
                    render
                        .entry
                        .locator
                        .as_ref()
                        .expect("function should have a locator"),
                ),
                SymbolView::DeclarationWithImports,
                0,
            )
            .expect("Go declaration-with-imports should resolve");
        let imported = &with_imports.blocks[0].source;
        assert!(imported.contains("import \"fmt\""));
        assert!(imported.contains("import alias \"strings\""));
        assert!(imported.contains("import . \"math\""));
        assert!(imported.contains("import _ \"embed\""));
        assert!(imported.contains("import \"math/rand/v2\""));
        assert!(!imported.contains("unused \"bytes\""));
        fs::remove_file(&imports_path).expect("Go import fixture should be removable");

        let crlf_path =
            std::env::temp_dir().join(format!("tau-ast-go-crlf-{}.go", std::process::id()));
        let crlf_source = "package fixture\r\n\r\n// Décode handles café.\r\nfunc Décode() string {\r\n\treturn \"café\"\r\n}\r\n";
        fs::write(&crlf_path, crlf_source).expect("Go CRLF fixture should be writable");
        let crlf = outline_file(&engine, &crlf_path, LanguageId::Go);
        let decode = crlf
            .items
            .iter()
            .find(|item| item.entry.name == "Décode")
            .expect("UTF-8 Go identifier should be extracted");
        assert_eq!(
            &crlf_source[decode.entry.name_range.start_byte..decode.entry.name_range.end_byte],
            "Décode"
        );
        assert_eq!(
            &crlf_source[decode.entry.range.start_byte..decode.entry.range.end_byte],
            "// Décode handles café.\r\nfunc Décode() string {\r\n\treturn \"café\"\r\n}"
        );
        fs::remove_file(&crlf_path).expect("Go CRLF fixture should be removable");

        let malformed_path =
            std::env::temp_dir().join(format!("tau-ast-go-recovery-{}.go", std::process::id()));
        fs::write(
            &malformed_path,
            "package fixture\n\nfunc Recovered() {\n\tvar broken =\n}\n",
        )
        .expect("malformed Go fixture should be writable");
        let malformed = outline_file(&engine, &malformed_path, LanguageId::Go);
        let recovered = malformed
            .items
            .iter()
            .find(|item| item.entry.name == "Recovered")
            .expect("recovered Go function should remain");
        assert!(matches!(
            recovered.entry.certainty,
            ParseCertainty::Recovered
        ));
        assert!(recovered.entry.certainty_reason.is_some());
        fs::remove_file(&malformed_path).expect("malformed Go fixture should be removable");
    }

    #[test]
    fn extracts_complete_java_declarations_ranges_visibility_and_selective_views() {
        let engine = OutlineEngine::new().expect("outline rules should compile");
        let fixture = Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/java.java");
        let source = fs::read_to_string(&fixture).expect("fixture should be readable");
        let result = outline_file(&engine, &fixture, LanguageId::Java);

        assert_eq!(result.diagnostics.error_nodes, 0);
        assert_eq!(result.diagnostics.missing_nodes, 0);
        assert_eq!(result.items[0].row_kind, OutlineRowKind::Package);
        assert_eq!(result.items[0].entry.name, "fixture");
        assert!(result.items[0].entry.locator.is_none());
        assert_eq!(result.items[1].row_kind, OutlineRowKind::Import);
        assert!(result.items[1].entry.locator.is_none());

        let parser = result
            .items
            .iter()
            .find(|item| item.entry.name == "Parser")
            .expect("generic interface should be extracted");
        assert!(parser.is_exported);
        assert!(parser.entry.signature.starts_with(
            "/** Parses source values. */\npublic interface Parser<T extends CharSequence> {"
        ));
        assert!(!parser.entry.signature.contains("return emptyList"));
        let parser_members = parser
            .members
            .iter()
            .map(|member| (member.entry.qualified_name.as_str(), member.is_public))
            .collect::<Vec<_>>();
        assert!(parser_members.contains(&("Parser.DEFAULT_LIMIT", true)));
        assert!(parser_members.contains(&("Parser.parse", true)));
        assert!(parser_members.contains(&("Parser.emptyValues", true)));
        assert!(parser_members.contains(&("Parser.reset", false)));
        assert!(parser_members.contains(&("Parser.Nested", true)));
        assert!(parser_members.contains(&("Parser.Nested.name", true)));
        assert!(parser_members.contains(&("Parser.Nested.hidden", false)));
        let parse = parser
            .members
            .iter()
            .find(|member| member.entry.qualified_name == "Parser.parse")
            .expect("interface method should be extracted");
        assert_eq!(
            parse.entry.signature,
            "Result parse(T source) throws IOException;"
        );
        assert!(parse.entry.body_range.is_none());

        let result_record = result
            .items
            .iter()
            .find(|item| item.entry.name == "Result")
            .expect("record should be extracted");
        assert_eq!(result_record.entry.symbol_type, SymbolType::Struct);
        let ok = result_record
            .members
            .iter()
            .find(|member| member.entry.qualified_name == "Result.ok")
            .expect("record component should be locatable");
        assert_eq!(ok.entry.ast_kind, "record_component");
        assert_eq!(
            &source[ok.entry.range.start_byte..ok.entry.range.end_byte],
            "boolean ok"
        );
        assert!(ok.is_public);
        assert!(result_record.members.iter().any(|member| {
            member.entry.symbol_type == SymbolType::Constructor
                && member.entry.ast_kind == "compact_constructor_declaration"
                && member.entry.body_range.is_some()
        }));
        let arguments = result
            .items
            .iter()
            .find(|item| item.entry.name == "Arguments")
            .expect("varargs record should be extracted");
        assert!(arguments.members.iter().any(|member| {
            member.entry.name == "rest"
                && member.entry.ast_kind == "record_component"
                && member.entry.signature == "String... rest"
        }));

        let state = result
            .items
            .iter()
            .find(|item| item.entry.name == "State")
            .expect("enum should be extracted");
        assert!(state.members.iter().any(|member| {
            member.entry.name == "READY" && member.entry.symbol_type == SymbolType::EnumMember
        }));
        let failed = state
            .members
            .iter()
            .find(|member| member.entry.name == "FAILED")
            .expect("enum constant body should be extracted");
        assert_eq!(failed.entry.signature, "FAILED(1) { … }");
        assert!(failed.entry.body_range.is_some());
        let action = result
            .items
            .iter()
            .find(|item| item.entry.name == "Action")
            .expect("lambda enum should be extracted");
        let run = action
            .members
            .iter()
            .find(|member| member.entry.name == "RUN")
            .expect("lambda enum constant should be extracted");
        assert_eq!(run.entry.signature, "RUN(() -> { … })");
        assert!(!run.entry.signature.contains("hidden lambda body"));
        let call = action
            .members
            .iter()
            .find(|member| member.entry.name == "CALL")
            .expect("expression lambda enum constant should be extracted");
        assert_eq!(call.entry.signature, "CALL(() -> …)");
        assert!(!call.entry.signature.contains("hidden expression body"));
        let empty = result
            .items
            .iter()
            .find(|item| item.entry.name == "Empty")
            .expect("empty enum should be extracted");
        assert!(
            empty
                .entry
                .signature
                .contains("{\n  ;\n  public void run()")
        );

        let marker = result
            .items
            .iter()
            .find(|item| item.entry.name == "Marker")
            .expect("annotation type should be extracted");
        let value = marker
            .members
            .iter()
            .find(|member| member.entry.name == "value")
            .expect("annotation element should be extracted");
        assert_eq!(value.entry.signature, "String value() default \"fixture\";");
        assert!(value.is_public);

        let file_parser = result
            .items
            .iter()
            .find(|item| item.entry.name == "FileParser")
            .expect("class should be extracted");
        let codes = file_parser
            .members
            .iter()
            .find(|member| member.entry.name == "CODES")
            .expect("initialized field should be extracted");
        assert_eq!(
            codes.entry.signature,
            "public static final Map<String, Integer> CODES = …;"
        );
        assert!(!codes.entry.signature.contains("Map.ofEntries"));
        assert!(codes.entry.body_range.is_some());
        assert!(file_parser.members.iter().any(|member| {
            member.entry.name == "packageCount" && member.entry.signature == "int packageCount;"
        }));
        assert!(file_parser.members.iter().any(|member| {
            member.entry.name == "otherCount" && member.entry.signature == "int otherCount = …;"
        }));
        assert!(file_parser.members.iter().any(|member| {
            member.entry.name == "<static initializer 1>"
                && member.entry.signature == "static { … }"
                && member.entry.body_range.is_some()
        }));
        assert!(file_parser.members.iter().any(|member| {
            member.entry.name == "<initializer 1>"
                && member.entry.signature == "{ … }"
                && member.entry.body_range.is_some()
        }));
        let implementation = file_parser
            .members
            .iter()
            .find(|member| member.entry.name == "parse")
            .expect("annotated implementation should be extracted");
        assert!(
            implementation
                .entry
                .signature
                .starts_with("/** Parses one source value. */\n@Override\npublic Result parse(")
        );
        assert!(
            implementation
                .entry
                .signature
                .ends_with(") throws IOException")
        );
        assert!(!implementation.entry.signature.contains("new Result"));

        let signature = engine
            .symbol(
                std::slice::from_ref(
                    implementation
                        .entry
                        .locator
                        .as_ref()
                        .expect("method should have a locator"),
                ),
                SymbolView::Signature,
                0,
            )
            .expect("Java signature should resolve");
        assert_eq!(signature.blocks[0].source, implementation.entry.signature);

        let with_imports = engine
            .symbol(
                std::slice::from_ref(
                    parser
                        .entry
                        .locator
                        .as_ref()
                        .expect("interface should have a locator"),
                ),
                SymbolView::DeclarationWithImports,
                0,
            )
            .expect("Java declaration-with-imports should resolve");
        let imported = &with_imports.blocks[0].source;
        assert!(imported.contains("import java.io.IOException;"));
        assert!(imported.contains("import java.time.*;"));
        assert!(imported.contains("import java.util.List;"));
        assert!(imported.contains("import static java.util.Collections.emptyList;"));
        assert!(!imported.contains("import java.util.Map;"));
        assert!(!imported.contains("import java.util.Set;"));
        assert!(!imported.contains("import static java.util.Map.entry;"));

        let public = engine
            .outline(
                OutlineTarget::File {
                    path: fixture.to_string_lossy().into_owned(),
                    language: LanguageId::Java,
                },
                false,
                true,
                &[],
            )
            .expect("public Java outline should parse");
        assert_eq!(
            public.files[0]
                .items
                .iter()
                .filter(|item| item.row_kind == OutlineRowKind::Declaration)
                .map(|item| item.entry.name.as_str())
                .collect::<Vec<_>>(),
            ["Parser"]
        );
        let public_parser = public.files[0]
            .items
            .iter()
            .find(|item| item.entry.name == "Parser")
            .expect("public interface should remain");
        assert!(
            public_parser
                .members
                .iter()
                .all(|member| { !matches!(member.entry.name.as_str(), "reset" | "hidden") })
        );

        let nested = engine
            .outline(
                OutlineTarget::File {
                    path: fixture.to_string_lossy().into_owned(),
                    language: LanguageId::Java,
                },
                false,
                true,
                &["Nested".to_owned()],
            )
            .expect("nested Java container filter should parse");
        let nested_parser = nested.files[0]
            .items
            .iter()
            .find(|item| item.entry.name == "Parser")
            .expect("nested container owner should remain");
        assert!(
            nested_parser
                .members
                .iter()
                .any(|member| member.entry.name == "Nested")
        );
        assert!(
            nested_parser
                .members
                .iter()
                .any(|member| member.entry.name == "name")
        );
        assert!(
            nested_parser
                .members
                .iter()
                .all(|member| member.entry.name != "parse")
        );

        let filtered_method = engine
            .outline(
                OutlineTarget::File {
                    path: fixture.to_string_lossy().into_owned(),
                    language: LanguageId::Java,
                },
                false,
                true,
                &["parse".to_owned()],
            )
            .expect("Java member filter should parse");
        let filtered_imports = filtered_method.files[0]
            .items
            .iter()
            .filter(|item| item.row_kind == OutlineRowKind::Import)
            .map(|item| item.entry.signature.as_str())
            .collect::<Vec<_>>();
        assert!(filtered_imports.contains(&"import java.io.IOException;"));
        assert!(filtered_imports.contains(&"import java.time.*;"));
        assert!(!filtered_imports.contains(&"import java.util.List;"));
        assert!(!filtered_imports.contains(&"import java.util.Map;"));
    }

    #[test]
    fn handles_java_utf8_crlf_and_recovery() {
        let engine = OutlineEngine::new().expect("outline rules should compile");
        let crlf_path =
            std::env::temp_dir().join(format!("tau-ast-java-crlf-{}.java", std::process::id()));
        let crlf_source = "/** Café parser. */\r\npublic@Deprecated class Café {\r\n    public String décode() {\r\n        return \"café\";\r\n    }\r\n}\r\n";
        fs::write(&crlf_path, crlf_source).expect("Java CRLF fixture should be writable");
        let crlf = outline_file(&engine, &crlf_path, LanguageId::Java);
        let cafe = crlf
            .items
            .iter()
            .find(|item| item.entry.name == "Café")
            .expect("UTF-8 Java class should be extracted");
        assert_eq!(
            &crlf_source[cafe.entry.name_range.start_byte..cafe.entry.name_range.end_byte],
            "Café"
        );
        assert_eq!(
            &crlf_source[cafe.entry.range.start_byte..cafe.entry.range.end_byte],
            "/** Café parser. */\r\npublic@Deprecated class Café {\r\n    public String décode() {\r\n        return \"café\";\r\n    }\r\n}"
        );
        fs::remove_file(&crlf_path).expect("Java CRLF fixture should be removable");

        let malformed_path =
            std::env::temp_dir().join(format!("tau-ast-java-recovery-{}.java", std::process::id()));
        fs::write(
            &malformed_path,
            "public class Recovered {\n    public void parse() {\n        String broken = ;\n    }\n}\n",
        )
        .expect("malformed Java fixture should be writable");
        let malformed = outline_file(&engine, &malformed_path, LanguageId::Java);
        let recovered = malformed
            .items
            .iter()
            .find(|item| item.entry.name == "Recovered")
            .expect("recovered Java class should remain");
        assert!(matches!(
            recovered.entry.certainty,
            ParseCertainty::Recovered
        ));
        assert!(recovered.entry.certainty_reason.is_some());
        fs::remove_file(&malformed_path).expect("malformed Java fixture should be removable");
    }

    #[test]
    fn extracts_complete_rust_declarations_ranges_visibility_and_selective_views() {
        let engine = OutlineEngine::new().expect("outline rules should compile");
        let fixture = Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/rust.rs");
        let source = fs::read_to_string(&fixture).expect("fixture should be readable");
        let result = outline_file(&engine, &fixture, LanguageId::Rust);

        assert_eq!(result.diagnostics.error_nodes, 0);
        assert_eq!(result.diagnostics.missing_nodes, 0);
        assert_eq!(result.items[0].row_kind, OutlineRowKind::Import);
        assert!(result.items[0].entry.locator.is_none());
        assert!(result.items.iter().any(|item| {
            item.row_kind == OutlineRowKind::Export
                && item.entry.signature == "pub use std::io::Result as IoResult;"
        }));
        assert!(result.items.iter().any(|item| {
            item.entry.name == "hidden_mod"
                && item.is_exported
                && item
                    .members
                    .iter()
                    .any(|member| member.entry.name == "Reexported" && member.is_public)
        }));

        let default_limit = result
            .items
            .iter()
            .find(|item| item.entry.name == "DEFAULT_LIMIT")
            .expect("public constant should be extracted");
        assert_eq!(
            default_limit.entry.signature,
            "/// Default parser capacity.\npub const DEFAULT_LIMIT: usize = …;"
        );
        assert_eq!(
            &source[default_limit.entry.range.start_byte..default_limit.entry.range.end_byte],
            "/// Default parser capacity.\npub const DEFAULT_LIMIT: usize = 10;"
        );
        assert!(default_limit.entry.body_range.is_some());

        let pair = result
            .items
            .iter()
            .find(|item| item.entry.name == "Pair")
            .expect("generic struct should be extracted");
        assert!(
            pair.entry
                .signature
                .starts_with("#[derive(Debug)]\npub struct Pair<T>\nwhere\n    T: Debug,\n{")
        );
        assert_eq!(
            pair.members
                .iter()
                .map(|member| (member.entry.name.as_str(), member.is_public))
                .collect::<Vec<_>>(),
            [("left", true), ("right", false)]
        );
        let pair_body = pair
            .entry
            .body_range
            .as_ref()
            .expect("struct should expose its body range");
        assert_eq!(
            &source[pair_body.start_byte..pair_body.end_byte],
            "{\n    pub left: T,\n    right: T,\n}"
        );

        let tuple = result
            .items
            .iter()
            .find(|item| item.entry.name == "Tuple")
            .expect("tuple struct should be extracted");
        assert!(tuple.entry.signature.starts_with("pub struct Tuple<T>(\n"));
        assert!(tuple.entry.signature.ends_with(") where T: Clone;"));
        assert_eq!(
            tuple
                .members
                .iter()
                .map(|member| member.entry.qualified_name.as_str())
                .collect::<Vec<_>>(),
            ["Tuple.0", "Tuple.1"]
        );

        let state = result
            .items
            .iter()
            .find(|item| item.entry.name == "State")
            .expect("enum should be extracted");
        assert!(state.entry.signature.contains("Named { value: T }"));
        assert!(state.members.iter().all(|member| member.is_public));

        let parser = result
            .items
            .iter()
            .find(|item| item.entry.name == "Parser")
            .expect("trait should be extracted");
        let ready = parser
            .members
            .iter()
            .find(|member| member.entry.name == "ready")
            .expect("default trait method should be extracted");
        assert_eq!(ready.entry.signature, "fn ready(&self) -> bool");
        assert!(ready.entry.body_range.is_some());
        assert!(ready.is_public);

        let inherent_impl = result
            .items
            .iter()
            .find(|item| {
                item.entry.ast_kind == "impl_item"
                    && item.entry.qualified_name == "FileParser"
                    && item
                        .members
                        .iter()
                        .any(|member| member.entry.name == "parse_async")
            })
            .expect("inherent impl should be extracted");
        let parse_async = inherent_impl
            .members
            .iter()
            .find(|member| member.entry.name == "parse_async")
            .expect("public async method should be extracted");
        assert!(
            parse_async
                .entry
                .signature
                .contains("where\n    T: AsRef<Path>")
        );
        assert!(!parse_async.entry.signature.contains("Some("));
        assert_eq!(parse_async.entry.qualified_name, "FileParser.parse_async");

        let trait_impl = result
            .items
            .iter()
            .find(|item| item.entry.qualified_name == "FileParser as Parser")
            .expect("trait impl should be qualified");
        assert!(trait_impl.members.iter().all(|member| member.is_public));

        let parser_macro = result
            .items
            .iter()
            .find(|item| item.entry.name == "parser_name")
            .expect("exported macro should be extracted");
        assert_eq!(
            parser_macro.entry.signature,
            "#[macro_export]\nmacro_rules! parser_name { … }"
        );
        assert!(parser_macro.entry.body_range.is_some());
        assert!(result.items.iter().any(|item| {
            item.entry.name == "extern \"C\""
                && item
                    .members
                    .iter()
                    .any(|member| member.entry.name == "fixture_open")
        }));
        let nested = result
            .items
            .iter()
            .find(|item| item.entry.name == "nested")
            .expect("inline module should be extracted");
        assert!(nested.members.iter().any(|member| {
            member.entry.name == "build"
                && member.entry.qualified_name == "nested.Public.build"
                && !member.entry.signature.contains("Self\n")
        }));
        let tuple_macro = result
            .items
            .iter()
            .find(|item| item.entry.name == "parser_tuple")
            .expect("parenthesized macro should be extracted");
        assert_eq!(
            tuple_macro.entry.signature,
            "#[macro_export(local_inner_macros)]\nmacro_rules! parser_tuple ( … );"
        );
        assert!(tuple_macro.entry.body_range.is_some());

        let signature = engine
            .symbol(
                std::slice::from_ref(
                    parse_async
                        .entry
                        .locator
                        .as_ref()
                        .expect("method should have a locator"),
                ),
                SymbolView::Signature,
                0,
            )
            .expect("Rust signature should resolve");
        assert_eq!(signature.blocks[0].source, parse_async.entry.signature);

        let with_imports = engine
            .symbol(
                std::slice::from_ref(
                    pair.entry
                        .locator
                        .as_ref()
                        .expect("struct should have a locator"),
                ),
                SymbolView::DeclarationWithImports,
                0,
            )
            .expect("Rust declaration-with-imports should resolve");
        assert!(
            with_imports.blocks[0]
                .source
                .contains("use std::{fmt::Debug, path::Path};")
        );
        assert!(
            with_imports.blocks[0]
                .source
                .contains("use std::collections::*;")
        );
        assert!(!with_imports.blocks[0].source.contains("extern crate alloc"));

        let public = engine
            .outline(
                OutlineTarget::File {
                    path: fixture.to_string_lossy().into_owned(),
                    language: LanguageId::Rust,
                },
                false,
                true,
                &[],
            )
            .expect("public Rust outline should parse");
        assert!(!public.files[0].items.iter().any(|item| {
            matches!(
                item.entry.name.as_str(),
                "INTERNAL_LIMIT" | "internal_parser" | "Hidden"
            )
        }));
        assert!(!public.files[0].items.iter().any(|item| {
            item.entry.ast_kind == "impl_item"
                && item
                    .members
                    .iter()
                    .any(|member| matches!(member.entry.name.as_str(), "exposed" | "secret"))
        }));
        let public_nested = public.files[0]
            .items
            .iter()
            .find(|item| item.entry.name == "nested")
            .expect("public module should remain");
        assert!(
            public_nested
                .members
                .iter()
                .all(|member| member.entry.name != "Private")
        );
        assert!(
            public_nested
                .members
                .iter()
                .any(|member| member.entry.name == "build")
        );
        let public_pair = public.files[0]
            .items
            .iter()
            .find(|item| item.entry.name == "Pair")
            .expect("public struct should remain");
        assert_eq!(public_pair.members.len(), 1);
        assert_eq!(public_pair.members[0].entry.name, "left");
    }

    #[test]
    fn handles_rust_utf8_crlf_and_recovery() {
        let engine = OutlineEngine::new().expect("outline rules should compile");
        let crlf_path =
            std::env::temp_dir().join(format!("tau-ast-rust-crlf-{}.rs", std::process::id()));
        let crlf_source =
            "/// Décode café.\r\npub fn décode() -> &'static str {\r\n    \"café\"\r\n}\r\n";
        fs::write(&crlf_path, crlf_source).expect("Rust CRLF fixture should be writable");
        let crlf = outline_file(&engine, &crlf_path, LanguageId::Rust);
        let decode = crlf
            .items
            .iter()
            .find(|item| item.entry.name == "décode")
            .expect("UTF-8 Rust identifier should be extracted");
        assert_eq!(
            &crlf_source[decode.entry.name_range.start_byte..decode.entry.name_range.end_byte],
            "décode"
        );
        assert_eq!(
            &crlf_source[decode.entry.range.start_byte..decode.entry.range.end_byte],
            "/// Décode café.\r\npub fn décode() -> &'static str {\r\n    \"café\"\r\n}"
        );
        fs::remove_file(&crlf_path).expect("Rust CRLF fixture should be removable");

        let malformed_path =
            std::env::temp_dir().join(format!("tau-ast-rust-recovery-{}.rs", std::process::id()));
        fs::write(
            &malformed_path,
            "pub fn recovered() {\n    let broken = ;\n}\n",
        )
        .expect("malformed Rust fixture should be writable");
        let malformed = outline_file(&engine, &malformed_path, LanguageId::Rust);
        let recovered = malformed
            .items
            .iter()
            .find(|item| item.entry.name == "recovered")
            .expect("recovered Rust function should remain");
        assert!(matches!(
            recovered.entry.certainty,
            ParseCertainty::Recovered
        ));
        assert!(recovered.entry.certainty_reason.is_some());
        fs::remove_file(&malformed_path).expect("malformed Rust fixture should be removable");
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
                    true,
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
            .symbol(
                std::slice::from_ref(
                    item.entry
                        .locator
                        .as_ref()
                        .expect("declaration should have a locator"),
                ),
                SymbolView::Declaration,
                0,
            )
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
            .symbol(
                std::slice::from_ref(
                    item.entry
                        .locator
                        .as_ref()
                        .expect("declaration should have a locator"),
                ),
                SymbolView::Declaration,
                0,
            )
            .expect_err("changed source should make the locator stale");
        assert_eq!(error.code, "stale_locator");

        fs::remove_file(temporary).expect("temporary fixture should be removable");
    }

    #[test]
    fn marks_declarations_uncertain_when_their_owner_contains_recovery() {
        let engine = OutlineEngine::new().expect("outline rules should compile");
        let temporary = std::env::temp_dir().join(format!(
            "tau-ast-recovered-declaration-{}.ts",
            std::process::id()
        ));
        fs::write(&temporary, "export const good = 1, broken: = 2;\n")
            .expect("temporary fixture should be writable");

        let result = outline_file(&engine, &temporary, LanguageId::TypeScript);
        let good = result
            .items
            .iter()
            .find(|item| item.entry.name == "good")
            .expect("valid sibling declarator should still be extracted");
        assert!(matches!(good.entry.certainty, ParseCertainty::Recovered));
        assert_eq!(
            good.entry.certainty_reason.as_deref(),
            Some("parser recovery intersects the declaration or its owning structure")
        );

        fs::remove_file(temporary).expect("temporary fixture should be removable");
    }

    #[test]
    fn retains_local_export_statements_and_marks_their_declarations_public() {
        let engine = OutlineEngine::new().expect("outline rules should compile");
        let temporary = std::env::temp_dir().join(format!(
            "tau-ast-local-exports-fixture-{}.ts",
            std::process::id()
        ));
        let source = r#"function localFunction(): number {
    return 1;
}

function buildThing(name: string): string {
    return name;
}

function hiddenThing(): number {
    return 2;
}

export { localFunction };
export { buildThing as createThing, buildThing as makeThing };
"#;
        fs::write(&temporary, source).expect("temporary fixture should be writable");

        let public = engine
            .outline(
                OutlineTarget::File {
                    path: temporary.to_string_lossy().into_owned(),
                    language: LanguageId::TypeScript,
                },
                false,
                true,
                &[],
            )
            .expect("public outline should parse")
            .files
            .into_iter()
            .next()
            .expect("file target should return one file");
        let declarations = public
            .items
            .iter()
            .filter(|item| item.row_kind == OutlineRowKind::Declaration)
            .map(|item| item.entry.name.as_str())
            .collect::<Vec<_>>();
        assert_eq!(declarations, ["localFunction", "buildThing"]);
        assert_eq!(
            public
                .items
                .iter()
                .filter(|item| item.row_kind == OutlineRowKind::Export)
                .count(),
            2
        );
        assert!(
            public
                .items
                .iter()
                .filter(|item| item.row_kind != OutlineRowKind::Declaration)
                .all(|item| item.entry.locator.is_none())
        );

        let local_function = public
            .items
            .iter()
            .find(|item| item.entry.name == "localFunction")
            .expect("unaliased local export should expose its declaration");
        let symbol = engine
            .symbol(
                std::slice::from_ref(
                    local_function
                        .entry
                        .locator
                        .as_ref()
                        .expect("declaration should have a locator"),
                ),
                SymbolView::Declaration,
                0,
            )
            .expect("resolved locator should retrieve the local declaration");
        assert_eq!(
            symbol.blocks[0].source,
            "function localFunction(): number {\n    return 1;\n}"
        );

        let filtered = engine
            .outline(
                OutlineTarget::File {
                    path: temporary.to_string_lossy().into_owned(),
                    language: LanguageId::TypeScript,
                },
                false,
                true,
                &["buildThing".to_owned()],
            )
            .expect("filtered outline should parse");
        assert_eq!(
            filtered.files[0]
                .items
                .iter()
                .filter(|item| item.row_kind == OutlineRowKind::Declaration)
                .map(|item| item.entry.name.as_str())
                .collect::<Vec<_>>(),
            ["buildThing"]
        );
        assert_eq!(
            filtered.files[0]
                .items
                .iter()
                .filter(|item| item.row_kind == OutlineRowKind::Export)
                .count(),
            1
        );

        fs::write(&temporary, format!("{source}\n// changed\n"))
            .expect("temporary fixture should be mutable");
        let error = engine
            .symbol(
                std::slice::from_ref(
                    local_function
                        .entry
                        .locator
                        .as_ref()
                        .expect("declaration should have a locator"),
                ),
                SymbolView::Declaration,
                0,
            )
            .expect_err("resolved locator should become stale after mutation");
        assert_eq!(error.code, "stale_locator");

        fs::remove_file(temporary).expect("temporary fixture should be removable");
    }

    #[test]
    fn resolves_tsx_local_export_clauses() {
        let engine = OutlineEngine::new().expect("outline rules should compile");
        let temporary = std::env::temp_dir().join(format!(
            "tau-ast-local-exports-fixture-{}.tsx",
            std::process::id()
        ));
        let source = "function View() {\n    return <div />;\n}\n\nexport { View };\n";
        fs::write(&temporary, source).expect("temporary fixture should be writable");

        let result = engine
            .outline(
                OutlineTarget::File {
                    path: temporary.to_string_lossy().into_owned(),
                    language: LanguageId::Tsx,
                },
                false,
                true,
                &[],
            )
            .expect("TSX outline should parse");
        let view = result.files[0]
            .items
            .iter()
            .find(|item| item.entry.name == "View")
            .expect("TSX local export should expose its declaration");
        assert_eq!(
            &source[view.entry.range.start_byte..view.entry.range.end_byte],
            "function View() {\n    return <div />;\n}"
        );
        assert_eq!(result.files[0].items.len(), 2);
        assert_eq!(result.files[0].items[1].row_kind, OutlineRowKind::Export);
        assert!(result.files[0].items[1].entry.locator.is_none());

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

        let filtered = engine
            .outline(
                OutlineTarget::Directory {
                    path: temporary.to_string_lossy().into_owned(),
                },
                true,
                true,
                &["A".to_owned()],
            )
            .expect("filtered directory should parse");
        assert_eq!(filtered.files.len(), 1);
        assert!(filtered.files[0].path.ends_with("a.ts"));
        assert_eq!(filtered.total_byte_length, result.total_byte_length);

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
