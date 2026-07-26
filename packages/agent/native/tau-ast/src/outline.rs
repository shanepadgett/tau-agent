use crate::csharp::{
    extract_csharp_items, filter_csharp_items, finalize_csharp_signatures, matching_csharp_imports,
};
use crate::go::{extract_go_items, filter_go_items, finalize_go_signatures, matching_go_imports};
use crate::java::{
    extract_java_items, filter_java_items, finalize_java_signatures, matching_java_imports,
};
use crate::kotlin::{
    extract_kotlin_items, filter_kotlin_items, finalize_kotlin_signatures, matching_kotlin_imports,
};
use crate::language::OdinLanguage;
use crate::markdown::{
    extract_markdown_items, filter_markdown_items, markdown_diagnostics, validate_markdown_source,
};
use crate::odin::{
    extract_odin_items, filter_odin_items, finalize_odin_signatures, matching_odin_imports,
};
use crate::rust::{
    extract_rust_items, filter_rust_items, finalize_rust_signatures, matching_rust_imports,
};
use crate::swift::{
    extract_swift_items, filter_swift_items, finalize_swift_signatures, matching_swift_imports,
};
use crate::typescript::{
    extract_typescript_items, filter_typescript_items, finalize_typescript_signatures,
};
use ast_grep_core::{Node, tree_sitter::LanguageExt};
use ast_grep_language::SupportLang;
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use ignore::WalkBuilder;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    error::Error,
    fmt, fs,
    io::Read,
    path::{Path, PathBuf},
    str,
    time::{Duration, Instant},
};

const LOCATOR_VERSION: u32 = 3;
const MAX_RECURSIVE_FILES: usize = 10_000;
const MAX_RECURSIVE_SOURCE_BYTES: usize = 256 * 1024 * 1024;
const MAX_RECURSIVE_DEPTH: usize = 128;
const MAX_RECURSIVE_ELAPSED_MS: u64 = 60_000;

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
    Markdown,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum OutlineTarget {
    File {
        path: String,
        language: LanguageId,
    },
    Directory {
        path: String,
    },
    RecursiveDirectory {
        path: String,
        budgets: RecursiveBudgets,
    },
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecursiveBudgets {
    pub max_files: usize,
    pub max_source_bytes: usize,
    pub max_depth: usize,
    pub max_elapsed_ms: u64,
}

#[derive(Clone, Debug)]
pub(crate) enum DeclarationFilter {
    ExactName(String),
    PrefixName(String),
    SubstringName(String),
    Kind(SymbolType),
}

impl DeclarationFilter {
    pub(crate) fn matches(&self, entry: &OutlineEntry) -> bool {
        match self {
            Self::ExactName(name) => entry.name == *name,
            Self::PrefixName(name) => entry.name.to_lowercase().starts_with(name),
            Self::SubstringName(name) => entry.name.to_lowercase().contains(name),
            Self::Kind(symbol_type) => entry.symbol_type == *symbol_type,
        }
    }

    fn exact_name(&self) -> Option<&String> {
        match self {
            Self::ExactName(name) => Some(name),
            _ => None,
        }
    }

    fn source_can_be_skipped(&self, language: LanguageId, source: &[u8]) -> bool {
        if !matches!(
            language,
            LanguageId::Odin | LanguageId::Go | LanguageId::Swift
        ) {
            return false;
        }
        match self {
            Self::ExactName(name) => !source
                .windows(name.len())
                .any(|window| window == name.as_bytes()),
            Self::PrefixName(name) | Self::SubstringName(name) => {
                str::from_utf8(source).is_ok_and(|source| !source.to_lowercase().contains(name))
            }
            Self::Kind(_) => false,
        }
    }
}

#[derive(Debug)]
pub enum RecursiveOutlineEvent {
    File {
        relative_path: String,
        file: OutlineFileResult,
    },
    Diagnostic(RecursiveDiagnostic),
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecursiveDiagnostic {
    pub relative_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language: Option<LanguageId>,
    pub code: &'static str,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_fingerprint: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecursiveOutlineSummary {
    pub discovered_files: usize,
    pub supported_files: usize,
    pub unsupported_files: usize,
    pub emitted_files: usize,
    pub unreadable_files: usize,
    pub oversized_files: usize,
    pub failed_files: usize,
    pub parser_degraded_files: usize,
    pub total_byte_length: usize,
    pub total_line_count: usize,
    pub file_limit_reached: bool,
    pub source_byte_limit_reached: bool,
    pub depth_limit_reached: bool,
    pub elapsed_limit_reached: bool,
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

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SymbolType {
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
    Object,
    EnumMember,
    Struct,
    Event,
    Operator,
    TypeParameter,
    Heading,
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
    pub diagnostics: Vec<String>,
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
    SignatureWithDocs,
    Declaration,
    DeclarationWithImports,
}

#[derive(Debug)]
pub struct SymbolError {
    pub code: &'static str,
    pub message: String,
}

#[derive(Debug)]
pub struct OutlineFileError {
    pub source_fingerprint: Option<String>,
    message: String,
}

impl fmt::Display for OutlineFileError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl Error for OutlineFileError {}

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
    include_private: bool,
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
    Match,
}

pub struct OutlineEngine;

impl OutlineEngine {
    pub fn new() -> Result<Self, Box<dyn Error>> {
        Ok(Self)
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
                if candidates
                    .iter()
                    .any(|(_, language)| *language != LanguageId::Markdown)
                {
                    candidates.retain(|(_, language)| *language != LanguageId::Markdown);
                }
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
            OutlineTarget::RecursiveDirectory { .. } => {
                return Err("recursive directory targets require streamed outline handling".into());
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
    ) -> Result<OutlineFileResult, OutlineFileError> {
        let source_bytes = fs::read(path).map_err(|error| OutlineFileError {
            source_fingerprint: None,
            message: error.to_string(),
        })?;
        let fingerprint = source_fingerprint(&source_bytes);
        self.outline_source(
            path,
            language,
            source_bytes,
            include_private,
            include_docs,
            names,
        )
        .map_err(|error| OutlineFileError {
            source_fingerprint: Some(fingerprint),
            message: error.to_string(),
        })
    }

    fn outline_source(
        &self,
        path: &Path,
        language: LanguageId,
        source_bytes: Vec<u8>,
        include_private: bool,
        include_docs: bool,
        names: &[String],
    ) -> Result<OutlineFileResult, Box<dyn Error>> {
        self.outline_source_filtered(
            path,
            language,
            source_bytes,
            include_private,
            include_docs,
            names,
            None,
        )
    }

    fn outline_source_filtered(
        &self,
        path: &Path,
        language: LanguageId,
        source_bytes: Vec<u8>,
        include_private: bool,
        include_docs: bool,
        names: &[String],
        declaration_filter: Option<&DeclarationFilter>,
    ) -> Result<OutlineFileResult, Box<dyn Error>> {
        let source = str::from_utf8(&source_bytes)?;
        let path = path.to_string_lossy().into_owned();
        let source_fingerprint = source_fingerprint(&source_bytes);
        let exact_discovery_name = declaration_filter
            .and_then(DeclarationFilter::exact_name)
            .filter(|_| !matches!(language, LanguageId::TypeScript | LanguageId::Tsx));
        let adapter_names = exact_discovery_name.map_or(names, std::slice::from_ref);
        let (diagnostics, mut items, directly_filtered) = match language {
            LanguageId::TypeScript => {
                let grep = SupportLang::TypeScript.ast_grep(source);
                let diagnostics = diagnostics(grep.root());
                let mut items = extract_typescript_items(grep.root(), source, include_docs);
                filter_typescript_items(grep.root(), &mut items, include_private, adapter_names);
                (diagnostics, items, true)
            }
            LanguageId::Tsx => {
                let grep = SupportLang::Tsx.ast_grep(source);
                let diagnostics = diagnostics(grep.root());
                let mut items = extract_typescript_items(grep.root(), source, include_docs);
                filter_typescript_items(grep.root(), &mut items, include_private, adapter_names);
                (diagnostics, items, true)
            }
            LanguageId::Odin => {
                let grep = OdinLanguage::Odin.ast_grep(source);
                let diagnostics = diagnostics(grep.root());
                let mut items = extract_odin_items(grep.root(), source, include_docs);
                filter_odin_items(
                    grep.root(),
                    source,
                    &mut items,
                    include_private,
                    adapter_names,
                );
                (diagnostics, items, true)
            }
            LanguageId::Go => {
                let grep = SupportLang::Go.ast_grep(source);
                let diagnostics = diagnostics(grep.root());
                let mut items = extract_go_items(grep.root(), source, include_docs);
                filter_go_items(
                    grep.root(),
                    source,
                    &mut items,
                    include_private,
                    adapter_names,
                );
                (diagnostics, items, true)
            }
            LanguageId::Rust => {
                let grep = SupportLang::Rust.ast_grep(source);
                let diagnostics = diagnostics(grep.root());
                let mut items = extract_rust_items(grep.root(), source, include_docs);
                filter_rust_items(
                    grep.root(),
                    source,
                    &mut items,
                    include_private,
                    adapter_names,
                );
                (diagnostics, items, true)
            }
            LanguageId::CSharp => {
                let grep = SupportLang::CSharp.ast_grep(source);
                let diagnostics = diagnostics(grep.root());
                let mut items = extract_csharp_items(grep.root(), source, include_docs);
                filter_csharp_items(
                    grep.root(),
                    source,
                    &mut items,
                    include_private,
                    adapter_names,
                );
                (diagnostics, items, true)
            }
            LanguageId::Java => {
                let grep = SupportLang::Java.ast_grep(source);
                let diagnostics = diagnostics(grep.root());
                let mut items = extract_java_items(grep.root(), source, include_docs);
                filter_java_items(
                    grep.root(),
                    source,
                    &mut items,
                    include_private,
                    adapter_names,
                );
                (diagnostics, items, true)
            }
            LanguageId::Kotlin => {
                let grep = SupportLang::Kotlin.ast_grep(source);
                let diagnostics = diagnostics(grep.root());
                let mut items = extract_kotlin_items(grep.root(), source, include_docs);
                filter_kotlin_items(
                    grep.root(),
                    source,
                    &mut items,
                    include_private,
                    adapter_names,
                );
                (diagnostics, items, true)
            }
            LanguageId::Swift => {
                let grep = SupportLang::Swift.ast_grep(source);
                let diagnostics = diagnostics(grep.root());
                let mut items = extract_swift_items(grep.root(), source, include_docs);
                filter_swift_items(
                    grep.root(),
                    source,
                    &mut items,
                    include_private,
                    adapter_names,
                );
                (diagnostics, items, true)
            }
            LanguageId::Markdown => {
                validate_markdown_source(source)?;
                let mut parser = tree_sitter::Parser::new();
                parser.set_language(&tree_sitter_md::LANGUAGE.into())?;
                let tree = parser
                    .parse(source, None)
                    .ok_or("Markdown parser did not return a syntax tree")?;
                let root = tree.root_node();
                let diagnostics = markdown_diagnostics(root);
                let mut items = extract_markdown_items(root, source);
                filter_markdown_items(&mut items, adapter_names);
                (diagnostics, items, true)
            }
        };
        let line_count = if source.is_empty() {
            0
        } else {
            source.bytes().filter(|byte| *byte == b'\n').count() + 1
        };
        if !directly_filtered {
            filter_items(&mut items, include_private, adapter_names);
        }
        if let Some(declaration_filter) = declaration_filter {
            prefilter_discovery_declarations(&mut items, declaration_filter);
        }
        if matches!(
            language,
            LanguageId::TypeScript
                | LanguageId::Tsx
                | LanguageId::Odin
                | LanguageId::Go
                | LanguageId::Rust
                | LanguageId::CSharp
                | LanguageId::Java
                | LanguageId::Kotlin
                | LanguageId::Swift
                | LanguageId::Markdown
        ) {
            match language {
                LanguageId::Odin => finalize_odin_signatures(&mut items),
                LanguageId::Go => finalize_go_signatures(&mut items),
                LanguageId::Rust => finalize_rust_signatures(&mut items),
                LanguageId::CSharp => finalize_csharp_signatures(&mut items),
                LanguageId::Java => finalize_java_signatures(&mut items),
                LanguageId::Kotlin => finalize_kotlin_signatures(&mut items),
                LanguageId::Swift => finalize_swift_signatures(&mut items),
                LanguageId::Markdown => {}
                _ => finalize_typescript_signatures(&mut items),
            }
            if let Some(declaration_filter) = declaration_filter {
                filter_finalized_discovery_declarations(&mut items, declaration_filter);
            }
            finalize_locators(
                &mut items,
                &path,
                language,
                &source_fingerprint,
                include_private,
            )?;
            if let Some(declaration_filter) = declaration_filter {
                for item in items
                    .iter_mut()
                    .filter(|item| item.row_kind == OutlineRowKind::Declaration)
                {
                    if !declaration_filter.matches(&item.entry) {
                        item.entry.locator = None;
                    }
                }
            }
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

    pub fn outline_recursive(
        &self,
        path: &str,
        budgets: RecursiveBudgets,
        include_private: bool,
        include_docs: bool,
        names: &[String],
        declaration_filter: Option<&DeclarationFilter>,
        emit: &mut impl FnMut(RecursiveOutlineEvent) -> Result<(), Box<dyn Error>>,
    ) -> Result<RecursiveOutlineSummary, Box<dyn Error>> {
        validate_recursive_budgets(budgets)?;
        let root = fs::canonicalize(path)?;
        if !root.is_dir() {
            return Err(format!(
                "recursive outline target is not a directory: {}",
                root.display()
            )
            .into());
        }

        struct Candidate {
            path: PathBuf,
            relative_path: String,
            language: LanguageId,
        }

        let started = Instant::now();
        let elapsed_limit = Duration::from_millis(budgets.max_elapsed_ms);
        let mut summary = RecursiveOutlineSummary {
            discovered_files: 0,
            supported_files: 0,
            unsupported_files: 0,
            emitted_files: 0,
            unreadable_files: 0,
            oversized_files: 0,
            failed_files: 0,
            parser_degraded_files: 0,
            total_byte_length: 0,
            total_line_count: 0,
            file_limit_reached: false,
            source_byte_limit_reached: false,
            depth_limit_reached: false,
            elapsed_limit_reached: false,
        };
        let mut candidates = Vec::new();
        let mut walker = WalkBuilder::new(&root);
        walker
            .standard_filters(true)
            .require_git(false)
            .follow_links(false)
            .sort_by_file_path(|left, right| left.cmp(right))
            .max_depth(Some(budgets.max_depth));

        for result in walker.build() {
            if started.elapsed() >= elapsed_limit {
                summary.elapsed_limit_reached = true;
                break;
            }
            let entry = match result {
                Ok(entry) => entry,
                Err(error) => {
                    summary.unreadable_files += 1;
                    emit(RecursiveOutlineEvent::Diagnostic(RecursiveDiagnostic {
                        relative_path: "?".to_owned(),
                        language: None,
                        code: "unreadable",
                        message: error.to_string(),
                        source_fingerprint: None,
                    }))?;
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
            summary.discovered_files += 1;
            let Some(language) = language_for_path(entry.path()) else {
                summary.unsupported_files += 1;
                continue;
            };
            if candidates.len() >= budgets.max_files {
                summary.file_limit_reached = true;
                break;
            }
            let canonical_path = match fs::canonicalize(entry.path()) {
                Ok(path) => path,
                Err(error) => {
                    summary.unreadable_files += 1;
                    emit(RecursiveOutlineEvent::Diagnostic(RecursiveDiagnostic {
                        relative_path: relative_path(
                            entry.path().strip_prefix(&root).unwrap_or(entry.path()),
                        ),
                        language: Some(language),
                        code: "unreadable",
                        message: error.to_string(),
                        source_fingerprint: None,
                    }))?;
                    continue;
                }
            };
            let relative = relative_path(canonical_path.strip_prefix(&root).map_err(|_| {
                format!(
                    "recursive outline path escaped its root: {}",
                    canonical_path.display()
                )
            })?);
            summary.supported_files += 1;
            candidates.push(Candidate {
                path: canonical_path,
                relative_path: relative,
                language,
            });
        }

        candidates.sort_by(|left, right| {
            left.relative_path
                .cmp(&right.relative_path)
                .then(left.path.cmp(&right.path))
        });
        for candidate in candidates {
            if started.elapsed() >= elapsed_limit {
                summary.elapsed_limit_reached = true;
                break;
            }
            let remaining = budgets
                .max_source_bytes
                .saturating_sub(summary.total_byte_length);
            let mut source = Vec::new();
            let read_result = fs::File::open(&candidate.path).and_then(|file| {
                file.take(u64::try_from(remaining).unwrap_or(u64::MAX) + 1)
                    .read_to_end(&mut source)
            });
            if let Err(error) = read_result {
                summary.unreadable_files += 1;
                emit(RecursiveOutlineEvent::Diagnostic(RecursiveDiagnostic {
                    relative_path: candidate.relative_path,
                    language: Some(candidate.language),
                    code: "unreadable",
                    message: error.to_string(),
                    source_fingerprint: None,
                }))?;
                continue;
            }
            if source.len() > remaining {
                summary.oversized_files += 1;
                summary.source_byte_limit_reached = true;
                emit(RecursiveOutlineEvent::Diagnostic(RecursiveDiagnostic {
                    relative_path: candidate.relative_path,
                    language: Some(candidate.language),
                    code: "sourceBudget",
                    message: format!(
                        "file exceeds the remaining {remaining}-byte recursive source budget"
                    ),
                    source_fingerprint: None,
                }))?;
                continue;
            }
            summary.total_byte_length += source.len();
            let failed_source_fingerprint = source_fingerprint(&source);
            let outlined = if declaration_filter.is_some_and(|declaration_filter| {
                declaration_filter.source_can_be_skipped(candidate.language, &source)
            }) {
                Ok(OutlineFileResult {
                    path: candidate.path.to_string_lossy().into_owned(),
                    language: candidate.language,
                    source_fingerprint: failed_source_fingerprint.clone(),
                    byte_length: source.len(),
                    line_count: if source.is_empty() {
                        0
                    } else {
                        source.iter().filter(|byte| **byte == b'\n').count() + 1
                    },
                    diagnostics: ParseDiagnostics {
                        error_nodes: 0,
                        missing_nodes: 0,
                    },
                    items: Vec::new(),
                })
            } else {
                self.outline_source_filtered(
                    &candidate.path,
                    candidate.language,
                    source,
                    include_private,
                    include_docs,
                    names,
                    declaration_filter,
                )
            };
            let file = match outlined {
                Ok(file) => file,
                Err(error) => {
                    summary.failed_files += 1;
                    emit(RecursiveOutlineEvent::Diagnostic(RecursiveDiagnostic {
                        relative_path: candidate.relative_path,
                        language: Some(candidate.language),
                        code: "outlineFailed",
                        message: error.to_string(),
                        source_fingerprint: Some(failed_source_fingerprint),
                    }))?;
                    continue;
                }
            };
            if started.elapsed() >= elapsed_limit {
                summary.elapsed_limit_reached = true;
                break;
            }
            summary.total_line_count += file.line_count;
            if file.diagnostics.error_nodes > 0 || file.diagnostics.missing_nodes > 0 {
                summary.parser_degraded_files += 1;
            }
            if !names.is_empty()
                && !file
                    .items
                    .iter()
                    .any(|item| item.row_kind == OutlineRowKind::Declaration)
            {
                continue;
            }
            summary.emitted_files += 1;
            emit(RecursiveOutlineEvent::File {
                relative_path: candidate.relative_path,
                file,
            })?;
        }
        if summary.total_byte_length >= budgets.max_source_bytes {
            summary.source_byte_limit_reached = true;
        }
        Ok(summary)
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
                        | LanguageId::Odin
                        | LanguageId::Go
                        | LanguageId::Rust
                        | LanguageId::CSharp
                        | LanguageId::Java
                        | LanguageId::Kotlin
                        | LanguageId::Swift
                        | LanguageId::Markdown
                )
            })
        {
            return Err(SymbolError {
                code: "unsupported_symbol_view",
                message: "signature, signatureWithDocs, and declarationWithImports views support TypeScript, TSX, Odin, Go, Rust, C#, Java, Kotlin, Swift, and Markdown"
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

        let mut reparsed = BTreeMap::<
            (String, bool),
            Result<(OutlineFileResult, Option<OutlineFileResult>), String>,
        >::new();
        if matches!(view, SymbolView::Signature | SymbolView::SignatureWithDocs) {
            for (_, locator) in &locators {
                let key = (locator.path.clone(), locator.include_private);
                if reparsed.contains_key(&key) {
                    continue;
                }
                let source = sources.get(&locator.path).ok_or_else(|| SymbolError {
                    code: "symbol_failed",
                    message: format!("failed to retain source for {}", locator.path),
                })?;
                let plain = self.outline_source(
                    Path::new(&locator.path),
                    locator.language,
                    source.as_bytes().to_vec(),
                    locator.include_private,
                    false,
                    &[],
                );
                let documented = if matches!(view, SymbolView::SignatureWithDocs) {
                    Some(self.outline_source(
                        Path::new(&locator.path),
                        locator.language,
                        source.as_bytes().to_vec(),
                        locator.include_private,
                        true,
                        &[],
                    ))
                } else {
                    None
                };
                reparsed.insert(
                    key,
                    match (plain, documented) {
                        (Ok(plain), Some(Ok(documented))) => Ok((plain, Some(documented))),
                        (Ok(plain), None) => Ok((plain, None)),
                        (Err(error), _) | (_, Some(Err(error))) => Err(error.to_string()),
                    },
                );
            }
        }
        let rendered_signatures = locators
            .iter()
            .map(|(_, locator)| {
                if !matches!(view, SymbolView::Signature | SymbolView::SignatureWithDocs) {
                    return (locator.signature.clone(), Vec::new());
                }
                let Some(reparsed) = reparsed.get(&(locator.path.clone(), locator.include_private)) else {
                    return (
                        locator.signature.clone(),
                        vec!["could not reparse attached documentation; returning the stored signature"
                            .to_owned()],
                    );
                };
                let (plain, documented) = match reparsed {
                    Ok(results) => results,
                    Err(error) => {
                        return (
                            locator.signature.clone(),
                            vec![format!(
                                "could not reparse attached documentation; returning the stored signature: {error}"
                            )],
                        );
                    }
                };
                let Some(plain_entry) = matching_entry(plain, locator) else {
                    return (
                        locator.signature.clone(),
                        vec!["could not confidently associate attached documentation with the current declaration; returning the stored signature"
                            .to_owned()],
                    );
                };
                if matches!(view, SymbolView::Signature) {
                    return (plain_entry.signature.clone(), Vec::new());
                }
                let Some(documented) = documented else {
                    return (
                        plain_entry.signature.clone(),
                        vec!["could not reparse attached documentation; returning the signature"
                            .to_owned()],
                    );
                };
                let Some(documented_entry) = matching_entry(documented, locator) else {
                    return (
                        plain_entry.signature.clone(),
                        vec!["could not confidently associate attached documentation with the current declaration; returning the signature"
                            .to_owned()],
                    );
                };
                let diagnostics = if locator.language != LanguageId::Markdown
                    && documented_entry.signature == plain_entry.signature
                {
                    vec!["no attached documentation was identified; nearby comments are not inferred by proximity"
                        .to_owned()]
                } else {
                    Vec::new()
                };
                (documented_entry.signature.clone(), diagnostics)
            })
            .collect::<Vec<_>>();
        let declarations = locators
            .iter()
            .zip(&rendered_signatures)
            .map(
                |((encoded_locator, locator), (_, diagnostics))| SymbolDeclaration {
                    locator: encoded_locator.clone(),
                    path: locator.path.clone(),
                    language: locator.language,
                    source_fingerprint: locator.source_fingerprint.clone(),
                    declaration_range: locator.range.clone(),
                    diagnostics: diagnostics.clone(),
                },
            )
            .collect::<Vec<_>>();
        let mut padded = Vec::<(String, usize, usize, Vec<usize>)>::new();
        for (index, (_, locator)) in locators.iter().enumerate() {
            let source = sources.get(&locator.path).ok_or_else(|| SymbolError {
                code: "symbol_failed",
                message: format!("failed to retain source for {}", locator.path),
            })?;
            let selected = locator.range.clone();
            let (start_byte, end_byte) =
                if matches!(view, SymbolView::Signature | SymbolView::SignatureWithDocs) {
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
                let block_source =
                    if matches!(view, SymbolView::Signature | SymbolView::SignatureWithDocs) {
                        declaration_indexes
                            .iter()
                            .map(|index| rendered_signatures[*index].0.as_str())
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

fn matching_entry<'a>(
    file: &'a OutlineFileResult,
    locator: &SourceLocator,
) -> Option<&'a OutlineEntry> {
    for item in &file.items {
        if entry_matches_locator(&item.entry, locator) {
            return Some(&item.entry);
        }
        if let Some(member) = item
            .members
            .iter()
            .find(|member| entry_matches_locator(&member.entry, locator))
        {
            return Some(&member.entry);
        }
    }
    None
}

fn entry_matches_locator(entry: &OutlineEntry, locator: &SourceLocator) -> bool {
    entry.qualified_name == locator.qualified_name
        && entry.ast_kind == locator.declaration_kind
        && entry.range.start_byte == locator.range.start_byte
        && entry.range.end_byte == locator.range.end_byte
        && entry.name_range.start_byte == locator.name_range.start_byte
        && entry.name_range.end_byte == locator.name_range.end_byte
}

pub(crate) fn validate_recursive_budgets(budgets: RecursiveBudgets) -> Result<(), Box<dyn Error>> {
    if budgets.max_files == 0 || budgets.max_files > MAX_RECURSIVE_FILES {
        return Err(
            format!("recursive maxFiles must be between 1 and {MAX_RECURSIVE_FILES}").into(),
        );
    }
    if budgets.max_source_bytes == 0 || budgets.max_source_bytes > MAX_RECURSIVE_SOURCE_BYTES {
        return Err(format!(
            "recursive maxSourceBytes must be between 1 and {MAX_RECURSIVE_SOURCE_BYTES}"
        )
        .into());
    }
    if budgets.max_depth == 0 || budgets.max_depth > MAX_RECURSIVE_DEPTH {
        return Err(
            format!("recursive maxDepth must be between 1 and {MAX_RECURSIVE_DEPTH}").into(),
        );
    }
    if budgets.max_elapsed_ms == 0 || budgets.max_elapsed_ms > MAX_RECURSIVE_ELAPSED_MS {
        return Err(format!(
            "recursive maxElapsedMs must be between 1 and {MAX_RECURSIVE_ELAPSED_MS}"
        )
        .into());
    }
    Ok(())
}

pub(crate) fn relative_path(path: &Path) -> String {
    path.components()
        .map(|component| component.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
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

fn prefilter_discovery_declarations(
    items: &mut Vec<OutlineItem>,
    declaration_filter: &DeclarationFilter,
) {
    items.retain_mut(|item| {
        if item.row_kind != OutlineRowKind::Declaration {
            return true;
        }
        let item_matches = declaration_filter.matches(&item.entry);
        if !item_matches {
            item.members
                .retain(|member| declaration_filter.matches(&member.entry));
        }
        item_matches || !item.members.is_empty()
    });
}

fn filter_finalized_discovery_declarations(
    items: &mut Vec<OutlineItem>,
    declaration_filter: &DeclarationFilter,
) {
    items.retain_mut(|item| {
        if item.row_kind != OutlineRowKind::Declaration {
            return true;
        }
        let item_matches = declaration_filter.matches(&item.entry);
        item.members
            .retain(|member| declaration_filter.matches(&member.entry));
        item_matches || !item.members.is_empty()
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
    Markdown,
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
        LanguageId::Markdown => LanguageFamily::Markdown,
    }
}

pub(crate) fn language_for_path(path: &Path) -> Option<LanguageId> {
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
        "md" | "markdown" | "mdown" => Some(LanguageId::Markdown),
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

fn finalize_locators(
    items: &mut [OutlineItem],
    path: &str,
    language: LanguageId,
    source_fingerprint: &str,
    include_private: bool,
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
            include_private,
        )?);
        for member in &mut item.members {
            member.entry.locator = Some(encode_locator(
                &member.entry,
                path,
                language,
                source_fingerprint,
                include_private,
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
    include_private: bool,
) -> Result<String, serde_json::Error> {
    Ok(URL_SAFE_NO_PAD.encode(serde_json::to_vec(&SourceLocator {
        version: LOCATOR_VERSION,
        path: path.to_owned(),
        language,
        source_fingerprint: source_fingerprint.to_owned(),
        include_private,
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

pub(crate) fn encode_search_match_locator(
    path: &str,
    language: LanguageId,
    source_fingerprint: &str,
    range: SourceRange,
    ast_kind: &str,
    signature: &str,
) -> Result<String, serde_json::Error> {
    encode_search_locator(
        path,
        language,
        source_fingerprint,
        range,
        ast_kind,
        signature,
        LocatorKind::Match,
    )
}

pub(crate) fn encode_search_scope_locator(
    path: &str,
    language: LanguageId,
    source_fingerprint: &str,
    range: SourceRange,
    ast_kind: &str,
    signature: &str,
) -> Result<String, serde_json::Error> {
    encode_search_locator(
        path,
        language,
        source_fingerprint,
        range,
        ast_kind,
        signature,
        LocatorKind::ExecutableScope,
    )
}

fn encode_search_locator(
    path: &str,
    language: LanguageId,
    source_fingerprint: &str,
    range: SourceRange,
    ast_kind: &str,
    signature: &str,
    locator_kind: LocatorKind,
) -> Result<String, serde_json::Error> {
    Ok(URL_SAFE_NO_PAD.encode(serde_json::to_vec(&SourceLocator {
        version: LOCATOR_VERSION,
        path: path.to_owned(),
        language,
        source_fingerprint: source_fingerprint.to_owned(),
        include_private: true,
        locator_kind,
        qualified_name: format!("<search:{ast_kind}:{}>", range.start_byte),
        declaration_kind: ast_kind.to_owned(),
        name_range: range.clone(),
        range,
        receiver_range: None,
        body_range: None,
        certainty: ParseCertainty::Certain,
        signature: signature.to_owned(),
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
        LanguageId::Odin => {
            let grep = OdinLanguage::Odin.ast_grep(source);
            matching_odin_imports(grep.root(), source, &locator.range)
        }
        LanguageId::Go => {
            let grep = SupportLang::Go.ast_grep(source);
            matching_go_imports(grep.root(), source, &locator.range)
        }
        LanguageId::Rust => {
            let grep = SupportLang::Rust.ast_grep(source);
            matching_rust_imports(grep.root(), source, &locator.range)
        }
        LanguageId::CSharp => {
            let grep = SupportLang::CSharp.ast_grep(source);
            matching_csharp_imports(grep.root(), source, &locator.range)
        }
        LanguageId::Java => {
            let grep = SupportLang::Java.ast_grep(source);
            matching_java_imports(grep.root(), source, &locator.range)
        }
        LanguageId::Kotlin => {
            let grep = SupportLang::Kotlin.ast_grep(source);
            matching_kotlin_imports(grep.root(), source, &locator.range)
        }
        LanguageId::Swift => {
            let grep = SupportLang::Swift.ast_grep(source);
            matching_swift_imports(grep.root(), source, &locator.range)
        }
        LanguageId::Markdown => Vec::new(),
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

pub(crate) fn source_fingerprint(source: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(source))
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
    fn extracts_markdown_heading_sections_and_selective_views() {
        let engine = OutlineEngine::new().expect("outline engine should initialize");
        let fixture = Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/markdown.md");
        let source = fs::read_to_string(&fixture).expect("Markdown fixture should be readable");
        let result = outline_file(&engine, &fixture, LanguageId::Markdown);

        assert_eq!(result.diagnostics.error_nodes, 0);
        assert_eq!(result.diagnostics.missing_nodes, 0);
        assert_eq!(
            result
                .items
                .iter()
                .map(|item| item.entry.name.as_str())
                .collect::<Vec<_>>(),
            ["Guide", "Installation", "macOS", "API Reference"]
        );
        assert!(
            result
                .items
                .iter()
                .all(|item| item.entry.symbol_type == SymbolType::Heading
                    && item.entry.locator.is_some()
                    && item.members.is_empty())
        );
        assert!(
            !result
                .items
                .iter()
                .any(|item| item.entry.name.contains("Fenced text"))
        );

        let installation = result
            .items
            .iter()
            .find(|item| item.entry.name == "Installation")
            .expect("installation heading should be extracted");
        assert_eq!(installation.entry.qualified_name, "Guide.Installation");
        assert_eq!(installation.entry.signature, "## Installation");
        let installation_source =
            &source[installation.entry.range.start_byte..installation.entry.range.end_byte];
        assert!(installation_source.starts_with("## Installation"));
        assert!(installation_source.contains("### macOS"));
        assert!(!installation_source.contains("API Reference"));

        let api = result
            .items
            .iter()
            .find(|item| item.entry.name == "API Reference")
            .expect("Setext heading should be extracted");
        assert_eq!(api.entry.qualified_name, "Guide.API Reference");
        assert_eq!(api.entry.signature, "API Reference\n-------------");
        assert_eq!(
            &source[api.entry.name_range.start_byte..api.entry.name_range.end_byte],
            "API Reference"
        );

        let locator = installation.entry.locator.as_ref().expect("locator");
        let signature = engine
            .symbol(std::slice::from_ref(locator), SymbolView::Signature, 0)
            .expect("Markdown signature should resolve");
        assert_eq!(signature.blocks[0].source, "## Installation");
        let documented_signature = engine
            .symbol(
                std::slice::from_ref(locator),
                SymbolView::SignatureWithDocs,
                0,
            )
            .expect("Markdown documented signature should preserve the heading model");
        assert_eq!(documented_signature.blocks[0].source, "## Installation");
        assert!(documented_signature.declarations[0].diagnostics.is_empty());
        let declaration = engine
            .symbol(std::slice::from_ref(locator), SymbolView::Declaration, 0)
            .expect("Markdown declaration should resolve");
        assert_eq!(declaration.blocks[0].source, installation_source);
        let with_imports = engine
            .symbol(
                std::slice::from_ref(locator),
                SymbolView::DeclarationWithImports,
                0,
            )
            .expect("Markdown declaration-with-imports should resolve");
        assert_eq!(with_imports.blocks[0].source, installation_source);

        let filtered = engine
            .outline(
                OutlineTarget::File {
                    path: fixture.to_string_lossy().into_owned(),
                    language: LanguageId::Markdown,
                },
                false,
                false,
                &["Guide.Installation.macOS".to_owned()],
            )
            .expect("qualified Markdown heading should filter");
        assert_eq!(filtered.files[0].items.len(), 1);
        assert_eq!(filtered.files[0].items[0].entry.name, "macOS");
    }

    #[test]
    fn handles_markdown_utf8_crlf_and_ignores_markdown_in_source_directories() {
        let engine = OutlineEngine::new().expect("outline engine should initialize");
        let temporary =
            std::env::temp_dir().join(format!("tau-ast-markdown-crlf-{}", std::process::id()));
        fs::create_dir_all(&temporary).expect("Markdown fixture directory should be writable");
        let markdown_path = temporary.join("guide.markdown");
        let source = "# Café\r\n\r\nIntro.\r\n\r\n## Décode\r\n\r\nInstructions.\r\n";
        fs::write(&markdown_path, source).expect("Markdown CRLF fixture should be writable");
        let result = outline_file(&engine, &markdown_path, LanguageId::Markdown);
        let decode = result
            .items
            .iter()
            .find(|item| item.entry.name == "Décode")
            .expect("UTF-8 heading should be extracted");
        assert_eq!(
            &source[decode.entry.name_range.start_byte..decode.entry.name_range.end_byte],
            "Décode"
        );
        assert_eq!(
            &source[decode.entry.range.start_byte..decode.entry.range.end_byte],
            "## Décode\r\n\r\nInstructions.\r\n"
        );

        fs::write(temporary.join("source.ts"), "export const value = 1;\n")
            .expect("TypeScript fixture should be writable");
        let directory = engine
            .outline(
                OutlineTarget::Directory {
                    path: temporary.to_string_lossy().into_owned(),
                },
                true,
                false,
                &[],
            )
            .expect("source directory should ignore adjacent Markdown");
        assert_eq!(directory.files.len(), 1);
        assert_eq!(directory.files[0].language, LanguageId::TypeScript);
        fs::remove_dir_all(temporary).expect("Markdown fixture directory should be removable");
    }

    #[test]
    fn normalizes_markdown_heading_names_and_excludes_block_container_headings() {
        let engine = OutlineEngine::new().expect("outline engine should initialize");
        let path = std::env::temp_dir().join(format!(
            "tau-ast-markdown-heading-names-{}.mdown",
            std::process::id()
        ));
        let source = "# Foo ###\n\nAlpha\nBeta\n=====\n\n> ## Quoted\n> quoted body\n\n- ### Listed\n\n# ###\n\n# Foo\u{a0}###\n";
        fs::write(&path, source).expect("Markdown heading fixture should be writable");
        let result = outline_file(&engine, &path, LanguageId::Markdown);
        assert_eq!(
            result
                .items
                .iter()
                .map(|item| item.entry.name.as_str())
                .collect::<Vec<_>>(),
            ["Foo", "Alpha Beta", "?", "Foo\u{a0}###"]
        );
        assert_eq!(result.items[0].entry.signature, "# Foo ###");
        assert_eq!(result.items[1].entry.signature, "Alpha\nBeta\n=====");
        assert!(
            !result
                .items
                .iter()
                .any(|item| matches!(item.entry.name.as_str(), "Quoted" | "Listed"))
        );
        assert!(
            validate_markdown_source(&format!("```markdown\n{}\n```\n", "> ".repeat(400))).is_ok()
        );
        assert!(validate_markdown_source(&format!(">\t{}# Deep\n", ">\t".repeat(400))).is_err());
        assert!(validate_markdown_source(&format!("{}item\n", "- ".repeat(400))).is_err());
        fs::remove_file(path).expect("Markdown heading fixture should be removable");
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
    fn redacts_nested_callable_and_object_field_initializers() {
        let engine = OutlineEngine::new().expect("outline engine should initialize");
        let path = std::env::temp_dir().join(format!(
            "tau-ast-typescript-field-bodies-{}.ts",
            std::process::id()
        ));
        let source = "export class App {\n  frame = { get: () => { return 1; }, cache: new Map() };\n  sync = wrap((value: string) => { return value; });\n  simple = new Map<string, number>();\n}\n";
        fs::write(&path, source).expect("TypeScript field fixture should be writable");
        let result = outline_file(&engine, &path, LanguageId::TypeScript);
        let app = result
            .items
            .iter()
            .find(|item| item.entry.name == "App")
            .expect("class should be extracted");
        let frame = app
            .members
            .iter()
            .find(|member| member.entry.name == "frame")
            .expect("object field should be extracted");
        assert_eq!(frame.entry.signature, "frame = …");
        assert!(frame.entry.body_range.is_some());
        let sync = app
            .members
            .iter()
            .find(|member| member.entry.name == "sync")
            .expect("wrapped callback field should be extracted");
        assert_eq!(sync.entry.signature, "sync = …");
        assert!(sync.entry.body_range.is_some());
        let simple = app
            .members
            .iter()
            .find(|member| member.entry.name == "simple")
            .expect("simple field should be extracted");
        assert_eq!(simple.entry.signature, "simple = new Map<string, number>()");
        assert!(simple.entry.body_range.is_none());
        assert!(!app.entry.signature.contains("return value"));
        fs::remove_file(path).expect("TypeScript field fixture should be removable");
    }

    #[test]
    fn extracts_typescript_namespaces_merged_declarations_and_type_members() {
        let engine = OutlineEngine::new().expect("outline engine should initialize");
        let path = std::env::temp_dir().join(format!(
            "tau-ast-typescript-namespace-{}.ts",
            std::process::id()
        ));
        let source = "export namespace API {\n  export interface Factory {\n    new (name: string): Service;\n    (id: number): Service;\n    [key: string]: unknown;\n    readonly value: string;\n  }\n  export class Service {\n    get name(): string { return 'service'; }\n    set name(value: string) {}\n  }\n}\nexport namespace API {\n  export const version = 1;\n}\nexport enum State { Ready, Failed = Ready }\n";
        fs::write(&path, source).expect("TypeScript namespace fixture should be writable");
        let result = outline_file(&engine, &path, LanguageId::TypeScript);
        let namespaces = result
            .items
            .iter()
            .filter(|item| item.entry.name == "API")
            .collect::<Vec<_>>();
        assert_eq!(namespaces.len(), 2);
        assert_ne!(namespaces[0].entry.locator, namespaces[1].entry.locator);
        let api = namespaces[0];
        assert!(api.entry.signature.starts_with("export namespace API {"));
        assert!(!api.entry.signature.contains("return 'service'"));
        let member_names = api
            .members
            .iter()
            .map(|member| member.entry.qualified_name.as_str())
            .collect::<Vec<_>>();
        for expected in [
            "API.Factory",
            "API.Factory.new",
            "API.Factory.call",
            "API.Factory.index",
            "API.Factory.value",
            "API.Service",
            "API.Service.name",
        ] {
            assert!(member_names.contains(&expected), "missing {expected}");
        }
        assert_eq!(
            api.members
                .iter()
                .filter(|member| member.entry.qualified_name == "API.Service.name")
                .count(),
            2
        );
        let state = result
            .items
            .iter()
            .find(|item| item.entry.name == "State")
            .expect("enum should be extracted");
        assert_eq!(state.members.len(), 2);

        let filtered = engine
            .outline(
                OutlineTarget::File {
                    path: path.to_string_lossy().into_owned(),
                    language: LanguageId::TypeScript,
                },
                false,
                false,
                &["Factory".to_owned()],
            )
            .expect("namespace member filter should parse");
        let filtered_api = filtered.files[0]
            .items
            .iter()
            .find(|item| item.entry.name == "API")
            .expect("namespace owner should remain");
        assert_eq!(filtered_api.members.len(), 5);
        assert!(
            filtered_api
                .members
                .iter()
                .all(|member| member.entry.qualified_name.starts_with("API.Factory"))
        );
        fs::remove_file(path).expect("TypeScript namespace fixture should be removable");
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
                LanguageId::Tsx,
                "tsx",
                "/** Service docs. */\n@sealed\nexport class Service {\n  /** Run docs. */\n  @logged\n  run(): void {}\n}\n",
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
                LanguageId::Odin,
                "odin",
                "// Service docs.\n@(require_results)\nService :: struct {\n  // Run docs.\n  Run: proc(),\n}\n",
                "Service",
                "Run",
                "@(require_results)",
                "Run: proc()",
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
            (
                LanguageId::CSharp,
                "cs",
                "/// <summary>\n/// Service docs.\n/// </summary>\n[Obsolete]\npublic class Service {\n    /// <summary>\n    /// Run docs.\n    /// </summary>\n    [Obsolete]\n    public void Run() {}\n}\n",
                "Service",
                "Run",
                "[Obsolete]",
                "[Obsolete]",
            ),
            (
                LanguageId::Kotlin,
                "kt",
                "/** Service docs. */\n@Deprecated(\"old\")\nclass Service {\n    /** Run docs. */\n    @Deprecated(\"old\")\n    fun run() {}\n}\n",
                "Service",
                "run",
                "@Deprecated",
                "@Deprecated",
            ),
            (
                LanguageId::Swift,
                "swift",
                "/// Service docs.\n@available(macOS 14, *)\npublic struct Service {\n    /// Run docs.\n    @available(macOS 14, *)\n    public func run() {}\n}\n",
                "Service",
                "run",
                "@available",
                "@available",
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
                    } else if language == LanguageId::Odin {
                        "// Service docs."
                    } else if language == LanguageId::CSharp {
                        "/// <summary>"
                    } else if matches!(language, LanguageId::Rust | LanguageId::Swift) {
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

            let documented_signature = engine
                .symbol(
                    std::slice::from_ref(
                        member
                            .entry
                            .locator
                            .as_ref()
                            .expect("member should have a locator"),
                    ),
                    SymbolView::SignatureWithDocs,
                    0,
                )
                .expect("documented signature should resolve from a default outline locator");
            assert!(
                documented_signature.blocks[0].source.contains("Run docs."),
                "{extension}"
            );
            assert!(
                documented_signature.blocks[0]
                    .source
                    .contains(member_attribute),
                "{extension}"
            );
            assert!(
                !documented_signature.blocks[0].source.contains("{}"),
                "{extension}"
            );
            assert!(
                documented_signature.declarations[0].diagnostics.is_empty(),
                "{extension}"
            );

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
            let documented_member = documented_item
                .members
                .iter()
                .find(|member| member.entry.name == member_name)
                .expect("documented member should remain");
            assert!(documented_member.entry.signature.contains("Run docs."));
            let plain_signature = engine
                .symbol(
                    std::slice::from_ref(
                        documented_member
                            .entry
                            .locator
                            .as_ref()
                            .expect("documented member should have a locator"),
                    ),
                    SymbolView::Signature,
                    0,
                )
                .expect("plain signature should resolve from a documented outline locator");
            assert!(
                !plain_signature.blocks[0].source.contains("Run docs."),
                "{extension}"
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
    fn documented_signatures_do_not_capture_unrelated_comments() {
        let engine = OutlineEngine::new().expect("outline engine should initialize");
        let cases = [
            (
                LanguageId::TypeScript,
                "ts",
                "/** Unrelated note. */\n\nexport function parse(): string { return 'value'; }\n",
                "parse",
            ),
            (
                LanguageId::Tsx,
                "tsx",
                "/** Unrelated note. */\n\nexport function parse(): string { return 'value'; }\n",
                "parse",
            ),
            (
                LanguageId::Odin,
                "odin",
                "package fixture\n\n// Unrelated note.\n\nparse :: proc() -> string { return \"value\" }\n",
                "parse",
            ),
            (
                LanguageId::Go,
                "go",
                "package fixture\n\n// Unrelated note.\n\nfunc Parse() string { return \"value\" }\n",
                "Parse",
            ),
            (
                LanguageId::Rust,
                "rs",
                "/// Unrelated note.\n\npub fn parse() -> &'static str { \"value\" }\n",
                "parse",
            ),
            (
                LanguageId::CSharp,
                "cs",
                "/// Unrelated note.\n\npublic class Parse {}\n",
                "Parse",
            ),
            (
                LanguageId::Java,
                "java",
                "/** Unrelated note. */\n\npublic class Parse {}\n",
                "Parse",
            ),
            (
                LanguageId::Kotlin,
                "kt",
                "/** Unrelated note. */\n\nfun parse(): String = \"value\"\n",
                "parse",
            ),
            (
                LanguageId::Swift,
                "swift",
                "/// Unrelated note.\n\npublic func parse() -> String { \"value\" }\n",
                "parse",
            ),
        ];

        for (language, extension, source, name) in cases {
            let path = std::env::temp_dir().join(format!(
                "tau-ast-unrelated-doc-comment-{}.{extension}",
                std::process::id()
            ));
            fs::write(&path, source).expect("documentation fixture should be writable");
            let outlined = engine
                .outline(
                    OutlineTarget::File {
                        path: path.to_string_lossy().into_owned(),
                        language,
                    },
                    true,
                    false,
                    &[],
                )
                .expect("fixture should parse");
            let declaration = outlined.files[0]
                .items
                .iter()
                .find(|item| item.entry.name == name)
                .expect("declaration should be extracted");
            let documented = engine
                .symbol(
                    std::slice::from_ref(declaration.entry.locator.as_ref().expect("locator")),
                    SymbolView::SignatureWithDocs,
                    0,
                )
                .expect("documented signature should resolve conservatively");

            assert!(
                !documented.blocks[0].source.contains("Unrelated note"),
                "{extension}"
            );
            assert_eq!(
                documented.declarations[0].diagnostics.len(),
                1,
                "{extension}"
            );
            assert!(
                documented.declarations[0].diagnostics[0].contains("nearby comments"),
                "{extension}"
            );
            fs::remove_file(path).expect("documentation fixture should be removable");
        }
    }

    #[test]
    fn signature_reparsing_preserves_public_outline_visibility() {
        let engine = OutlineEngine::new().expect("outline engine should initialize");
        let path = std::env::temp_dir().join(format!(
            "tau-ast-public-signature-{}.ts",
            std::process::id()
        ));
        fs::write(
            &path,
            "/** Service docs. */\nexport class Service {\n  public run(): void {}\n  private hidden(): void {}\n}\n",
        )
        .expect("visibility fixture should be writable");
        let outlined = engine
            .outline(
                OutlineTarget::File {
                    path: path.to_string_lossy().into_owned(),
                    language: LanguageId::TypeScript,
                },
                false,
                false,
                &[],
            )
            .expect("public outline should parse");
        let service = outlined.files[0]
            .items
            .iter()
            .find(|item| item.entry.name == "Service")
            .expect("public class should be extracted");
        for view in [SymbolView::Signature, SymbolView::SignatureWithDocs] {
            let signature = engine
                .symbol(
                    std::slice::from_ref(service.entry.locator.as_ref().expect("locator")),
                    view,
                    0,
                )
                .expect("public signature should resolve");
            assert!(signature.blocks[0].source.contains("run"));
            assert!(!signature.blocks[0].source.contains("hidden"));
        }
        fs::remove_file(path).expect("visibility fixture should be removable");
    }

    #[test]
    fn signature_reparsing_keeps_visibility_separate_within_one_batch() {
        let engine = OutlineEngine::new().expect("outline engine should initialize");
        let path = std::env::temp_dir().join(format!(
            "tau-ast-mixed-visibility-signature-{}.ts",
            std::process::id()
        ));
        fs::write(
            &path,
            "/** Service docs. */\nexport class Service {\n  public run(): void {}\n  private hidden(): void {}\n}\n",
        )
        .expect("visibility fixture should be writable");
        let public = engine
            .outline(
                OutlineTarget::File {
                    path: path.to_string_lossy().into_owned(),
                    language: LanguageId::TypeScript,
                },
                false,
                false,
                &[],
            )
            .expect("public outline should parse");
        let private = engine
            .outline(
                OutlineTarget::File {
                    path: path.to_string_lossy().into_owned(),
                    language: LanguageId::TypeScript,
                },
                true,
                false,
                &[],
            )
            .expect("private outline should parse");
        let public_service = public.files[0]
            .items
            .iter()
            .find(|item| item.entry.name == "Service")
            .expect("public class should be extracted");
        let private_hidden = private.files[0]
            .items
            .iter()
            .find(|item| item.entry.name == "Service")
            .and_then(|item| {
                item.members
                    .iter()
                    .find(|member| member.entry.name == "hidden")
            })
            .expect("private member should be extracted");
        let signatures = engine
            .symbol(
                &[
                    public_service
                        .entry
                        .locator
                        .as_ref()
                        .expect("public locator")
                        .clone(),
                    private_hidden
                        .entry
                        .locator
                        .as_ref()
                        .expect("private locator")
                        .clone(),
                ],
                SymbolView::Signature,
                0,
            )
            .expect("mixed-visibility signatures should resolve");

        assert!(
            signatures
                .declarations
                .iter()
                .all(|declaration| declaration.diagnostics.is_empty())
        );
        assert_eq!(signatures.blocks[0].source.matches("hidden").count(), 1);
        fs::remove_file(path).expect("visibility fixture should be removable");
    }

    #[test]
    fn rust_documented_signature_excludes_an_interleaved_ordinary_comment() {
        let engine = OutlineEngine::new().expect("outline engine should initialize");
        let path = std::env::temp_dir().join(format!(
            "tau-ast-rust-interleaved-comment-{}.rs",
            std::process::id()
        ));
        fs::write(
            &path,
            "/// Parse docs.\n// Unrelated café implementation note.\n#[doc = r#\"// keep raw attribute text\"#]\n#[inline]\npub fn parse() -> usize { 1 }\n",
        )
        .expect("Rust documentation fixture should be writable");
        let outlined = outline_file(&engine, &path, LanguageId::Rust);
        let parse = outlined
            .items
            .iter()
            .find(|item| item.entry.name == "parse")
            .expect("Rust function should be extracted");
        let documented = engine
            .symbol(
                std::slice::from_ref(parse.entry.locator.as_ref().expect("locator")),
                SymbolView::SignatureWithDocs,
                0,
            )
            .expect("Rust documented signature should resolve");

        assert!(documented.blocks[0].source.contains("/// Parse docs."));
        assert!(
            documented.blocks[0]
                .source
                .contains("#[doc = r#\"// keep raw attribute text\"#]")
        );
        assert!(documented.blocks[0].source.contains("#[inline]"));
        assert!(
            !documented.blocks[0]
                .source
                .contains("Unrelated implementation note")
        );
        assert!(documented.declarations[0].diagnostics.is_empty());
        fs::remove_file(path).expect("Rust documentation fixture should be removable");
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
        assert!(names.contains(&"Value"));
        assert!(names.contains(&"Permissions"));
        assert!(names.contains(&"first_count"));
        assert!(names.contains(&"second_count"));

        let source = fs::read_to_string(&fixture).expect("Odin fixture should be readable");
        let circle = result
            .items
            .iter()
            .find(|item| item.entry.name == "Circle")
            .expect("struct should be extracted");
        assert_eq!(circle.members.len(), 4);
        assert!(circle.members.iter().any(|member| {
            member.entry.name == "bounds_min" && member.entry.signature == "bounds_min: Vec2,"
        }));
        assert!(circle.members.iter().any(|member| {
            member.entry.name == "bounds_max" && member.entry.signature == "bounds_max: Vec2,"
        }));
        assert!(circle.entry.signature.starts_with("Circle :: struct {"));
        assert!(!circle.entry.signature.contains("return"));
        let length = result
            .items
            .iter()
            .find(|item| item.entry.name == "vec2_length")
            .expect("procedure should be extracted");
        assert_eq!(
            length.entry.signature,
            "vec2_length :: proc(v: Vec2) -> f32"
        );
        assert!(length.entry.body_range.is_some());
        assert!(!length.entry.signature.contains("math.sqrt"));
        let mapped = result
            .items
            .iter()
            .find(|item| item.entry.name == "map_value")
            .expect("attributed polymorphic procedure should be extracted");
        assert!(mapped.entry.signature.contains("@(require_results)"));
        assert!(mapped.entry.signature.contains("$T: typeid"));
        assert!(mapped.entry.signature.contains("(result: T, ok: bool)"));
        let foreign = result
            .items
            .iter()
            .find(|item| item.entry.name == "foreign libc")
            .expect("foreign block should be extracted");
        assert!(foreign.members.iter().any(|member| {
            member.entry.name == "strlen" && member.entry.qualified_name == "foreign libc.strlen"
        }));
        let value = result
            .items
            .iter()
            .find(|item| item.entry.name == "Value")
            .expect("union should be extracted");
        assert!(value.entry.signature.contains("int,"));
        assert!(value.entry.signature.contains("string,"));
        assert!(value.entry.signature.contains("fmt.Formatter,"));
        let shape = result
            .items
            .iter()
            .find(|item| item.entry.name == "Shape_Kind")
            .expect("enum should be extracted");
        assert_eq!(
            shape
                .members
                .iter()
                .map(|member| member.entry.name.as_str())
                .collect::<Vec<_>>(),
            ["Circle", "Segment"]
        );
        assert!(shape.entry.signature.contains("Segment = Circle,"));
        let callback = result
            .items
            .iter()
            .find(|item| item.entry.name == "Callback")
            .expect("#type procedure alias should be extracted");
        assert!(
            callback
                .entry
                .signature
                .contains("#type proc \"contextless\"")
        );
        let hidden_cache = result
            .items
            .iter()
            .find(|item| item.entry.name == "hidden_cache")
            .expect("attributed private variable should be extracted");
        assert_eq!(
            hidden_cache.entry.signature,
            "@(private=\"file\")\nhidden_cache: int"
        );
        assert!(!hidden_cache.is_exported);
        let initialized = result
            .items
            .iter()
            .find(|item| item.entry.name == "initialized")
            .expect("initialized typed variable should be extracted");
        assert_eq!(initialized.entry.signature, "initialized: int = …");
        let typed_limit = result
            .items
            .iter()
            .find(|item| item.entry.name == "typed_limit")
            .expect("typed constant should be extracted");
        assert_eq!(typed_limit.entry.signature, "typed_limit: int : …");
        let exact = engine
            .symbol(
                std::slice::from_ref(length.entry.locator.as_ref().expect("locator")),
                SymbolView::Declaration,
                0,
            )
            .expect("Odin declaration should resolve");
        assert_eq!(
            exact.blocks[0].source,
            source[length.entry.range.start_byte..length.entry.range.end_byte]
        );
        let with_imports = engine
            .symbol(
                std::slice::from_ref(mapped.entry.locator.as_ref().expect("locator")),
                SymbolView::DeclarationWithImports,
                0,
            )
            .expect("Odin imports should resolve");
        assert!(
            with_imports.blocks[0]
                .source
                .contains("import fmt \"core:fmt\"")
        );
        assert!(
            !with_imports.blocks[0]
                .source
                .contains("import \"core:math\"")
        );
        assert!(!with_imports.blocks[0].source.contains("import unused"));

        let hidden = result
            .items
            .iter()
            .find(|item| item.entry.name == "hidden_length")
            .expect("private procedure should be extracted");
        assert!(!hidden.is_exported);
    }

    #[test]
    fn handles_odin_utf8_crlf_visibility_and_recovery() {
        let engine = OutlineEngine::new().expect("outline engine should initialize");
        let crlf_path =
            std::env::temp_dir().join(format!("tau-ast-odin-crlf-{}.odin", std::process::id()));
        let crlf_source =
            "package café\r\n\r\n// Décode café.\r\nCafé :: struct {\r\n\tvaleur: string,\r\n}\r\n";
        fs::write(&crlf_path, crlf_source).expect("Odin CRLF fixture should be writable");
        let crlf = outline_file(&engine, &crlf_path, LanguageId::Odin);
        let cafe = crlf
            .items
            .iter()
            .find(|item| item.entry.name == "Café")
            .expect("UTF-8 Odin struct should be extracted");
        assert_eq!(
            &crlf_source[cafe.entry.name_range.start_byte..cafe.entry.name_range.end_byte],
            "Café"
        );
        assert!(
            crlf_source[cafe.entry.range.start_byte..cafe.entry.range.end_byte]
                .starts_with("// Décode café.")
        );
        fs::remove_file(crlf_path).expect("Odin CRLF fixture should be removable");

        let malformed_path =
            std::env::temp_dir().join(format!("tau-ast-odin-recovery-{}.odin", std::process::id()));
        fs::write(
            &malformed_path,
            "package fixture\n\nRecovered :: proc() { broken := }\n",
        )
        .expect("malformed Odin fixture should be writable");
        let malformed = outline_file(&engine, &malformed_path, LanguageId::Odin);
        let recovered = malformed
            .items
            .iter()
            .find(|item| item.entry.name == "Recovered")
            .expect("recovered Odin procedure should remain");
        assert!(matches!(
            recovered.entry.certainty,
            ParseCertainty::Recovered
        ));
        fs::remove_file(malformed_path).expect("malformed Odin fixture should be removable");
    }

    #[test]
    fn extracts_complete_csharp_declarations_visibility_ranges_and_selective_views() {
        let engine = OutlineEngine::new().expect("outline rules should compile");
        let fixture = Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/csharp.cs");
        let source = fs::read_to_string(&fixture).expect("fixture should be readable");
        let result = outline_file(&engine, &fixture, LanguageId::CSharp);

        assert_eq!(result.diagnostics.error_nodes, 0);
        assert_eq!(result.diagnostics.missing_nodes, 0);
        assert_eq!(result.items[0].row_kind, OutlineRowKind::Import);
        assert_eq!(result.items[4].row_kind, OutlineRowKind::Package);
        assert!(result.items[0].entry.locator.is_none());

        let parser = result
            .items
            .iter()
            .find(|item| item.entry.name == "IParser")
            .expect("interface should be extracted");
        assert_eq!(parser.entry.qualified_name, "Fixture.Parsing.IParser");
        assert!(
            parser.entry.signature.starts_with(
                "/// <summary>Parses source values.</summary>\npublic interface IParser<T> where T : class\n{"
            ),
            "{}",
            parser.entry.signature
        );
        assert!(parser.members.iter().any(|member| {
            member.entry.name == "Parse"
                && member.entry.qualified_name == "Fixture.Parsing.IParser.Parse"
                && member.is_public
        }));

        let file_parser = result
            .items
            .iter()
            .find(|item| item.entry.name == "FileParser")
            .expect("partial class should be extracted");
        assert!(file_parser.is_exported);
        assert!(file_parser.entry.signature.contains("where T : class\n{"));
        assert!(!file_parser.entry.signature.contains("return new Result"));
        let source_property = file_parser
            .members
            .iter()
            .find(|member| member.entry.name == "Source")
            .expect("property should be extracted");
        assert_eq!(source_property.entry.signature, "public Text Source { … }");
        assert!(file_parser.members.iter().any(|member| {
            member.entry.qualified_name == "Fixture.Parsing.FileParser.Source.get"
                && member.is_public
        }));
        assert!(file_parser.members.iter().any(|member| {
            member.entry.qualified_name == "Fixture.Parsing.FileParser.Source.set"
                && !member.is_public
        }));
        assert!(file_parser.members.iter().any(|member| {
            member.entry.name == "operator +"
                && member.entry.symbol_type == SymbolType::Operator
                && member.entry.body_range.is_some()
        }));
        let explicit = file_parser
            .members
            .iter()
            .find(|member| member.entry.signature.contains("IParser<T>.Parse"))
            .expect("explicit interface implementation should be extracted");
        assert!(!explicit.is_public);
        assert_eq!(
            explicit.entry.signature,
            "Result IParser<T>.Parse(T source) => …;"
        );
        assert_eq!(
            &source[explicit.entry.range.start_byte..explicit.entry.range.end_byte],
            "Result IParser<T>.Parse(T source) => Parse(source);"
        );

        let signature = engine
            .symbol(
                std::slice::from_ref(explicit.entry.locator.as_ref().expect("locator")),
                SymbolView::Signature,
                0,
            )
            .expect("C# signature should resolve");
        assert_eq!(signature.blocks[0].source, explicit.entry.signature);
        let with_imports = engine
            .symbol(
                std::slice::from_ref(source_property.entry.locator.as_ref().expect("locator")),
                SymbolView::DeclarationWithImports,
                0,
            )
            .expect("C# declaration-with-imports should resolve");
        assert!(
            with_imports.blocks[0]
                .source
                .contains("using Text = System.String;")
        );
        assert!(
            with_imports.blocks[0]
                .source
                .contains("global using System;")
        );

        let public = engine
            .outline(
                OutlineTarget::File {
                    path: fixture.to_string_lossy().into_owned(),
                    language: LanguageId::CSharp,
                },
                false,
                false,
                &[],
            )
            .expect("public C# outline should parse");
        assert!(
            !public.files[0]
                .items
                .iter()
                .any(|item| item.entry.name == "HiddenParser")
        );
        let public_file_parser = public.files[0]
            .items
            .iter()
            .find(|item| item.entry.name == "FileParser")
            .expect("public class should remain");
        assert!(
            !public_file_parser
                .members
                .iter()
                .any(|member| { matches!(member.entry.name.as_str(), "Counts" | "set" | "Hide") })
        );
    }

    #[test]
    fn handles_csharp_utf8_crlf_block_namespaces_and_recovery() {
        let engine = OutlineEngine::new().expect("outline rules should compile");
        let crlf_path =
            std::env::temp_dir().join(format!("tau-ast-csharp-crlf-{}.cs", std::process::id()));
        let crlf_source = "namespace Fixture {\r\n/// <summary>Décode café.</summary>\r\npublic partial class Café {\r\n    public string Décode() => \"café\";\r\n}\r\n}\r\n";
        fs::write(&crlf_path, crlf_source).expect("C# CRLF fixture should be writable");
        let crlf = outline_file(&engine, &crlf_path, LanguageId::CSharp);
        let cafe = crlf
            .items
            .iter()
            .find(|item| item.entry.name == "Café")
            .expect("UTF-8 C# class should be extracted");
        assert_eq!(cafe.entry.qualified_name, "Fixture.Café");
        assert_eq!(
            &crlf_source[cafe.entry.name_range.start_byte..cafe.entry.name_range.end_byte],
            "Café"
        );
        assert!(
            crlf_source[cafe.entry.range.start_byte..cafe.entry.range.end_byte]
                .starts_with("/// <summary>Décode café.</summary>")
        );
        fs::remove_file(&crlf_path).expect("C# CRLF fixture should be removable");

        let malformed_path =
            std::env::temp_dir().join(format!("tau-ast-csharp-recovery-{}.cs", std::process::id()));
        fs::write(
            &malformed_path,
            "public class Recovered { public void Parse() { string broken = ; } }\n",
        )
        .expect("malformed C# fixture should be writable");
        let malformed = outline_file(&engine, &malformed_path, LanguageId::CSharp);
        let recovered = malformed
            .items
            .iter()
            .find(|item| item.entry.name == "Recovered")
            .expect("recovered C# class should remain");
        assert!(matches!(
            recovered.entry.certainty,
            ParseCertainty::Recovered
        ));
        assert!(recovered.entry.certainty_reason.is_some());
        fs::remove_file(&malformed_path).expect("malformed C# fixture should be removable");
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
    fn extracts_complete_kotlin_declarations_visibility_ranges_and_selective_views() {
        let engine = OutlineEngine::new().expect("outline rules should compile");
        let fixture = Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/kotlin.kt");
        let source = fs::read_to_string(&fixture).expect("fixture should be readable");
        let result = outline_file(&engine, &fixture, LanguageId::Kotlin);

        assert_eq!(result.diagnostics.error_nodes, 0);
        assert_eq!(result.diagnostics.missing_nodes, 0);
        assert_eq!(result.items[1].row_kind, OutlineRowKind::Package);
        assert_eq!(result.items[2].row_kind, OutlineRowKind::Import);
        assert!(result.items[1].entry.locator.is_none());

        let parser = result
            .items
            .iter()
            .find(|item| item.entry.name == "Parser")
            .expect("interface should be extracted");
        assert_eq!(parser.entry.symbol_type, SymbolType::Interface);
        assert!(
            parser
                .entry
                .signature
                .starts_with("/** Parses source values. */")
        );

        let file_parser = result
            .items
            .iter()
            .find(|item| item.entry.name == "FileParser")
            .expect("sealed class should be extracted");
        assert!(file_parser.is_exported);
        assert!(
            file_parser
                .entry
                .signature
                .contains("where T : Comparable<T> {")
        );
        assert!(!file_parser.entry.signature.contains("return Result"));
        assert!(file_parser.members.iter().any(|member| {
            member.entry.qualified_name == "FileParser.constructor"
                && member.entry.symbol_type == SymbolType::Constructor
        }));
        assert!(file_parser.members.iter().any(|member| {
            member.entry.qualified_name == "FileParser.hidden" && !member.is_public
        }));
        assert!(file_parser.members.iter().any(|member| {
            member.entry.qualified_name == "FileParser.mutable.set"
                && member.entry.body_range.is_some()
        }));
        assert!(file_parser.members.iter().any(|member| {
            member.entry.qualified_name == "FileParser.Named.create"
                && member.entry.signature.ends_with("= …")
        }));
        assert!(file_parser.members.iter().any(|member| {
            member.entry.qualified_name == "FileParser.memberExtension"
                && member.entry.receiver_range.is_some()
        }));
        let secondary = file_parser
            .members
            .iter()
            .find(|member| member.entry.name == "constructor" && member.entry.body_range.is_some())
            .expect("secondary constructor should expose its outer body");
        let secondary_body = secondary.entry.body_range.as_ref().expect("body");
        assert!(source[secondary_body.start_byte..secondary_body.end_byte].starts_with('{'));
        assert!(!secondary.entry.signature.contains("check(input"));
        let parse = file_parser
            .members
            .iter()
            .find(|member| member.entry.qualified_name == "FileParser.parse")
            .expect("method should be extracted");
        assert_eq!(
            parse.entry.signature,
            "override fun parse(source: String): Result"
        );
        let parse_body = parse
            .entry
            .body_range
            .as_ref()
            .expect("method should expose body");
        assert!(source[parse_body.start_byte..parse_body.end_byte].starts_with('{'));

        let create = result
            .items
            .iter()
            .find(|item| item.entry.name == "createParser")
            .expect("expression-bodied function should be extracted");
        assert_eq!(
            create.entry.signature,
            "fun createParser(input: Input): Parser = …"
        );
        assert!(create.entry.body_range.is_some());

        let signature = engine
            .symbol(
                std::slice::from_ref(create.entry.locator.as_ref().expect("locator")),
                SymbolView::Signature,
                0,
            )
            .expect("Kotlin signature should resolve");
        assert_eq!(signature.blocks[0].source, create.entry.signature);
        let with_imports = engine
            .symbol(
                std::slice::from_ref(create.entry.locator.as_ref().expect("locator")),
                SymbolView::DeclarationWithImports,
                0,
            )
            .expect("Kotlin imports should resolve");
        assert!(
            with_imports.blocks[0]
                .source
                .contains("import fixture.types.Input")
        );
        assert!(
            with_imports.blocks[0]
                .source
                .contains("import fixture.types.*")
        );
        assert!(
            !with_imports.blocks[0]
                .source
                .contains("kotlin.collections.Set")
        );

        let public = engine
            .outline(
                OutlineTarget::File {
                    path: fixture.to_string_lossy().into_owned(),
                    language: LanguageId::Kotlin,
                },
                false,
                true,
                &[],
            )
            .expect("public Kotlin outline should parse");
        assert!(
            !public.files[0]
                .items
                .iter()
                .any(|item| item.entry.name == "trimmed")
        );
        let public_file_parser = public.files[0]
            .items
            .iter()
            .find(|item| item.entry.name == "FileParser")
            .expect("public class should remain");
        assert!(!public_file_parser.members.iter().any(|member| {
            matches!(
                member.entry.name.as_str(),
                "hidden" | "mutable" | "computed"
            )
        }));
    }

    #[test]
    fn extracts_complete_swift_declarations_visibility_ranges_and_selective_views() {
        let engine = OutlineEngine::new().expect("outline rules should compile");
        let fixture = Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/swift.swift");
        let source = fs::read_to_string(&fixture).expect("fixture should be readable");
        let result = outline_file(&engine, &fixture, LanguageId::Swift);

        assert_eq!(result.diagnostics.error_nodes, 0);
        assert_eq!(result.diagnostics.missing_nodes, 0);
        assert_eq!(result.items[0].row_kind, OutlineRowKind::Import);
        assert!(result.items[0].entry.locator.is_none());

        let parser = result
            .items
            .iter()
            .find(|item| item.entry.name == "Parser")
            .expect("protocol should be extracted");
        assert_eq!(parser.entry.symbol_type, SymbolType::Interface);
        assert!(
            parser
                .entry
                .signature
                .starts_with("/// Parses source values.")
        );
        assert!(!parser.entry.signature.contains("source.trimmingCharacters"));
        assert!(parser.members.iter().any(|member| {
            member.entry.qualified_name == "Parser.Output"
                && member.entry.symbol_type == SymbolType::TypeParameter
                && member.is_public
        }));
        assert!(
            parser.members.iter().any(|member| {
                member.entry.qualified_name == "Parser.parse" && member.is_public
            })
        );
        assert!(parser.members.iter().any(|member| {
            member.entry.qualified_name == "Parser.subscript"
                && member.entry.symbol_type == SymbolType::Operator
        }));

        let file_parser = result
            .items
            .iter()
            .find(|item| item.entry.name == "FileParser")
            .expect("open class should be extracted");
        assert!(file_parser.is_exported);
        let parse = file_parser
            .members
            .iter()
            .find(|member| member.entry.name == "parse")
            .expect("method should be extracted");
        assert_eq!(
            parse.entry.signature,
            "open func parse(_ source: borrowing String) async throws -> String"
        );
        let parse_body = parse.entry.body_range.as_ref().expect("method body range");
        assert!(source[parse_body.start_byte..parse_body.end_byte].starts_with('{'));
        assert!(
            file_parser
                .members
                .iter()
                .any(|member| { member.entry.name == "secret" && !member.is_public })
        );
        assert!(
            file_parser.members.iter().any(|member| {
                member.entry.name == "deinit" && member.entry.body_range.is_some()
            })
        );

        let state = result
            .items
            .iter()
            .find(|item| item.entry.name == "State")
            .expect("enum should be extracted");
        assert!(state.members.iter().any(|member| {
            member.entry.name == "loaded"
                && member.entry.symbol_type == SymbolType::EnumMember
                && member.is_public
        }));
        assert!(
            state
                .members
                .iter()
                .any(|member| { member.entry.name == "failed" && !member.is_public })
        );

        let extension = result
            .items
            .iter()
            .find(|item| item.entry.symbol_type == SymbolType::Namespace)
            .expect("extension should remain separately locatable");
        assert!(
            extension
                .entry
                .qualified_name
                .starts_with("extension Result")
        );
        assert!(extension.members.iter().any(|member| {
            member.entry.name == "mapped"
                && member.entry.qualified_name.starts_with("extension Result")
        }));

        let make_date = result
            .items
            .iter()
            .find(|item| item.entry.name == "makeDate")
            .expect("top-level function should be extracted");
        let with_imports = engine
            .symbol(
                std::slice::from_ref(make_date.entry.locator.as_ref().expect("locator")),
                SymbolView::DeclarationWithImports,
                0,
            )
            .expect("Swift declaration-with-imports should resolve");
        let imported = &with_imports.blocks[0].source;
        assert!(imported.contains("@_implementationOnly import Foundation"));
        assert!(imported.contains("import struct Foundation.Date"));
        assert!(imported.contains("import Collections"));
        assert!(!imported.contains("import struct Foundation.URL"));

        let public = engine
            .outline(
                OutlineTarget::File {
                    path: fixture.to_string_lossy().into_owned(),
                    language: LanguageId::Swift,
                },
                false,
                true,
                &[],
            )
            .expect("public Swift outline should parse");
        assert!(
            !public.files[0].items.iter().any(|item| {
                matches!(item.entry.name.as_str(), "PackageOnly" | "internalHelper")
            })
        );
        let public_result = public.files[0]
            .items
            .iter()
            .find(|item| item.entry.name == "Result")
            .expect("public struct should remain");
        assert!(public_result.members.iter().all(|member| {
            !matches!(
                member.entry.name.as_str(),
                "packageValue" | "cached" | "hidden"
            )
        }));

        let filtered = engine
            .outline(
                OutlineTarget::File {
                    path: fixture.to_string_lossy().into_owned(),
                    language: LanguageId::Swift,
                },
                false,
                true,
                &["mapped".to_owned()],
            )
            .expect("Swift member filter should parse");
        let filtered_extension = filtered.files[0]
            .items
            .iter()
            .find(|item| item.entry.symbol_type == SymbolType::Namespace)
            .expect("extension owner should remain");
        assert_eq!(filtered_extension.members.len(), 1);
        assert_eq!(filtered_extension.members[0].entry.name, "mapped");
    }

    #[test]
    fn handles_swift_utf8_crlf_and_recovery() {
        let engine = OutlineEngine::new().expect("outline rules should compile");
        let crlf_path =
            std::env::temp_dir().join(format!("tau-ast-swift-crlf-{}.swift", std::process::id()));
        let crlf_source = "/// Décode café.\r\npublic struct Café {\r\n    /// Valeur — décodée.\r\n    public var valeur: String { \"café\" }\r\n    /// Décode méthode — café.\r\n    public func décode() -> String { \"café\" }\r\n}\r\n";
        fs::write(&crlf_path, crlf_source).expect("Swift CRLF fixture should be writable");
        let crlf = outline_file(&engine, &crlf_path, LanguageId::Swift);
        let cafe = crlf
            .items
            .iter()
            .find(|item| item.entry.name == "Café")
            .expect("UTF-8 Swift struct should be extracted");
        assert_eq!(
            &crlf_source[cafe.entry.name_range.start_byte..cafe.entry.name_range.end_byte],
            "Café"
        );
        assert!(
            crlf_source[cafe.entry.range.start_byte..cafe.entry.range.end_byte]
                .starts_with("/// Décode café.")
        );
        let value = cafe
            .members
            .iter()
            .find(|member| member.entry.name == "valeur")
            .expect("documented UTF-8 Swift property should be extracted");
        assert_eq!(
            value.entry.signature,
            "/// Valeur — décodée.\npublic var valeur: String { … }"
        );
        let decode = cafe
            .members
            .iter()
            .find(|member| member.entry.name == "décode")
            .expect("documented UTF-8 Swift method should be extracted");
        assert_eq!(
            decode.entry.signature,
            "/// Décode méthode — café.\npublic func décode() -> String"
        );
        fs::remove_file(&crlf_path).expect("Swift CRLF fixture should be removable");

        let malformed_path = std::env::temp_dir().join(format!(
            "tau-ast-swift-recovery-{}.swift",
            std::process::id()
        ));
        fs::write(
            &malformed_path,
            "public struct Recovered {\n    public func parse() { let broken = }\n}\n",
        )
        .expect("malformed Swift fixture should be writable");
        let malformed = outline_file(&engine, &malformed_path, LanguageId::Swift);
        let recovered = malformed
            .items
            .iter()
            .find(|item| item.entry.name == "Recovered")
            .expect("recovered Swift struct should remain");
        assert!(matches!(
            recovered.entry.certainty,
            ParseCertainty::Recovered
        ));
        assert!(recovered.entry.certainty_reason.is_some());
        fs::remove_file(&malformed_path).expect("malformed Swift fixture should be removable");
    }

    #[test]
    fn handles_kotlin_utf8_crlf_and_split_class_headers() {
        let engine = OutlineEngine::new().expect("outline rules should compile");
        let path = std::env::temp_dir().join(format!("tau-ast-kotlin-{}.kt", std::process::id()));
        let source = "/** Café. */\r\nclass Café(val entrée: String) {\r\n  fun décode(): String = entrée\r\n}\r\n";
        fs::write(&path, source).expect("Kotlin recovery fixture should be writable");
        let result = outline_file(&engine, &path, LanguageId::Kotlin);
        let cafe = result
            .items
            .iter()
            .find(|item| item.entry.name == "Café")
            .expect("recovered class should remain");
        assert_eq!(
            &source[cafe.entry.name_range.start_byte..cafe.entry.name_range.end_byte],
            "Café"
        );
        let exact = engine
            .symbol(
                std::slice::from_ref(cafe.entry.locator.as_ref().expect("locator")),
                SymbolView::Declaration,
                0,
            )
            .expect("recovered declaration should resolve");
        assert_eq!(exact.blocks[0].source, source.trim_end());
        fs::remove_file(path).expect("Kotlin fixture should be removable");
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
        assert!(
            signature.blocks[0]
                .source
                .starts_with("@Override\npublic Result parse(")
        );
        assert!(
            !signature.blocks[0]
                .source
                .contains("Parses one source value.")
        );

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
    fn rejects_a_mixed_symbol_batch_atomically_when_one_locator_is_stale() {
        let engine = OutlineEngine::new().expect("outline engine should initialize");
        let directory = std::env::temp_dir().join(format!(
            "tau-ast-mixed-stale-symbols-{}",
            std::process::id()
        ));
        fs::create_dir_all(&directory).expect("symbol fixture directory should be writable");
        let first_path = directory.join("first.ts");
        let second_path = directory.join("second.ts");
        fs::write(&first_path, "export function first() { return 1; }\n")
            .expect("first symbol fixture should be writable");
        fs::write(&second_path, "export function second() { return 2; }\n")
            .expect("second symbol fixture should be writable");
        let first = outline_file(&engine, &first_path, LanguageId::TypeScript);
        let second = outline_file(&engine, &second_path, LanguageId::TypeScript);
        let first_locator = first.items[0]
            .entry
            .locator
            .as_ref()
            .expect("first locator");
        let second_locator = second.items[0]
            .entry
            .locator
            .as_ref()
            .expect("second locator");
        fs::write(&second_path, "export function second() { return 3; }\n")
            .expect("second symbol fixture should be mutable");

        let error = engine
            .symbol(
                &[first_locator.clone(), second_locator.clone()],
                SymbolView::Declaration,
                0,
            )
            .expect_err("one stale locator should reject the complete mixed batch");
        assert_eq!(error.code, "stale_locator");
        fs::remove_dir_all(directory).expect("symbol fixture directory should be removable");
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
    fn recursively_outlines_every_language_in_stable_ignore_aware_order() {
        let engine = OutlineEngine::new().expect("outline engine should initialize");
        let temporary =
            std::env::temp_dir().join(format!("tau-ast-recursive-fixture-{}", std::process::id()));
        let nested = temporary.join("nested");
        fs::create_dir_all(&nested).expect("recursive fixture should be writable");
        fs::write(temporary.join("a.ts"), "export const a = 1;\n").expect("TypeScript fixture");
        fs::write(temporary.join("b.tsx"), "export const B = () => <div />;\n")
            .expect("TSX fixture");
        fs::write(
            temporary.join("c.odin"),
            "package fixture\n\nC :: struct { value: int, }\n",
        )
        .expect("Odin fixture");
        fs::write(temporary.join("d.go"), "package fixture\n\nfunc D() {}\n").expect("Go fixture");
        fs::write(temporary.join("e.rs"), "pub fn e() {}\n").expect("Rust fixture");
        fs::write(temporary.join("f.cs"), "public class F {}\n").expect("C# fixture");
        fs::write(temporary.join("g.java"), "public class G {}\n").expect("Java fixture");
        fs::write(temporary.join("h.kt"), "fun h() = 1\n").expect("Kotlin fixture");
        fs::write(temporary.join("i.swift"), "public func i() {}\n").expect("Swift fixture");
        fs::write(temporary.join("j.md"), "# J\n\nBody.\n").expect("Markdown fixture");
        fs::write(nested.join("ignored.rs"), "pub fn ignored() {}\n").expect("ignored fixture");
        fs::write(temporary.join("README.txt"), "unsupported\n").expect("unsupported fixture");
        fs::write(temporary.join(".gitignore"), "nested/ignored.rs\n").expect("ignore rules");

        let mut files = Vec::new();
        let summary = engine
            .outline_recursive(
                &temporary.to_string_lossy(),
                RecursiveBudgets {
                    max_files: 20,
                    max_source_bytes: 1024 * 1024,
                    max_depth: 8,
                    max_elapsed_ms: 5_000,
                },
                true,
                false,
                &[],
                None,
                &mut |event| {
                    if let RecursiveOutlineEvent::File {
                        relative_path,
                        file,
                    } = event
                    {
                        files.push((relative_path, file.language));
                    }
                    Ok(())
                },
            )
            .expect("recursive outline should complete");

        assert_eq!(
            files,
            [
                ("a.ts".to_owned(), LanguageId::TypeScript),
                ("b.tsx".to_owned(), LanguageId::Tsx),
                ("c.odin".to_owned(), LanguageId::Odin),
                ("d.go".to_owned(), LanguageId::Go),
                ("e.rs".to_owned(), LanguageId::Rust),
                ("f.cs".to_owned(), LanguageId::CSharp),
                ("g.java".to_owned(), LanguageId::Java),
                ("h.kt".to_owned(), LanguageId::Kotlin),
                ("i.swift".to_owned(), LanguageId::Swift),
                ("j.md".to_owned(), LanguageId::Markdown),
            ]
        );
        assert_eq!(summary.emitted_files, 10);
        assert_eq!(summary.unsupported_files, 1);
        assert_eq!(summary.failed_files, 0);
        fs::remove_dir_all(temporary).expect("recursive fixture should be removable");
    }

    #[test]
    fn rejects_empty_and_mixed_language_directories() {
        let engine = OutlineEngine::new().expect("outline rules should compile");
        let temporary = std::env::temp_dir().join(format!(
            "tau-ast-invalid-directory-fixture-{}",
            std::process::id()
        ));
        fs::create_dir_all(&temporary).expect("temporary directory should be writable");
        fs::write(temporary.join("README.txt"), "empty\n")
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
