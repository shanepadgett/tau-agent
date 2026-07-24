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
use std::{error::Error, fmt, fs, path::Path, str};

const LOCATOR_VERSION: u32 = 1;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutlineResult {
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
pub struct SymbolResult {
    pub path: String,
    pub language: LanguageId,
    pub source_fingerprint: String,
    pub range: SourceRange,
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
        path: &Path,
        language: LanguageId,
    ) -> Result<OutlineResult, Box<dyn Error>> {
        let path = fs::canonicalize(path)?;
        let source_bytes = fs::read(&path)?;
        let source = str::from_utf8(&source_bytes)?;
        let path = path.to_string_lossy().into_owned();
        let source_fingerprint = source_fingerprint(&source_bytes);
        let (diagnostics, items) = match language {
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

        Ok(OutlineResult {
            path,
            language,
            source_fingerprint,
            byte_length: source.len(),
            line_count,
            diagnostics,
            items,
        })
    }

    pub fn symbol(&self, encoded_locator: &str) -> Result<SymbolResult, SymbolError> {
        let locator_bytes =
            URL_SAFE_NO_PAD
                .decode(encoded_locator)
                .map_err(|error| SymbolError {
                    code: "invalid_locator",
                    message: format!("locator is not valid base64url: {error}"),
                })?;
        let locator: SourceLocator =
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
        let source = str::from_utf8(&source_bytes).map_err(|error| SymbolError {
            code: "symbol_failed",
            message: format!("{} is not valid UTF-8: {error}", locator.path),
        })?;
        let declaration = source
            .get(locator.range.start_byte..locator.range.end_byte)
            .ok_or_else(|| SymbolError {
                code: "invalid_locator",
                message: "locator range is outside the source or splits a UTF-8 character"
                    .to_owned(),
            })?;

        Ok(SymbolResult {
            path: locator.path,
            language: locator.language,
            source_fingerprint: locator.source_fingerprint,
            range: locator.range,
            source: declaration.to_owned(),
        })
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
    Ok(OutlineItem {
        entry: outline_entry(item.entry, path, language, source_fingerprint)?,
        is_import: item.is_import,
        is_exported: item.is_exported,
        members: item
            .members
            .into_iter()
            .map(|member| {
                Ok(OutlineMember {
                    entry: outline_entry(member.entry, path, language, source_fingerprint)?,
                    is_public: member.is_public,
                })
            })
            .collect::<Result<Vec<_>, serde_json::Error>>()?,
    })
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

    #[test]
    fn extracts_typescript_fixture() {
        let engine = OutlineEngine::new().expect("outline rules should compile");
        let fixture = Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/typescript.ts");
        let result = engine
            .outline(&fixture, LanguageId::TypeScript)
            .expect("TypeScript fixture should parse");
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
        let result = engine
            .outline(&fixture, LanguageId::Odin)
            .expect("Odin fixture should parse");
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
            let result = engine
                .outline(&fixture, language)
                .expect("fixture should parse");
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
                .symbol(&item.entry.locator)
                .expect("fresh locator should resolve");
            assert_eq!(
                symbol.source,
                source[item.entry.range.start_byte..item.entry.range.end_byte],
                "{file}"
            );
        }
    }

    #[test]
    fn retrieves_exact_symbol_source_and_rejects_stale_locator() {
        let engine = OutlineEngine::new().expect("outline rules should compile");
        let fixture = Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/typescript.ts");
        let source = fs::read_to_string(&fixture).expect("fixture should be readable");
        let temporary =
            std::env::temp_dir().join(format!("tau-ast-symbol-fixture-{}.ts", std::process::id()));
        fs::write(&temporary, &source).expect("temporary fixture should be writable");

        let result = engine
            .outline(&temporary, LanguageId::TypeScript)
            .expect("temporary fixture should parse");
        let item = result
            .items
            .iter()
            .find(|item| item.entry.name == "FileParser")
            .expect("fixture should contain FileParser");
        let symbol = engine
            .symbol(&item.entry.locator)
            .expect("fresh locator should resolve");

        assert_eq!(
            symbol.source,
            source[item.entry.range.start_byte..item.entry.range.end_byte]
        );
        assert_eq!(symbol.source_fingerprint, result.source_fingerprint);

        fs::write(&temporary, format!("// changed\n{source}"))
            .expect("temporary fixture should be mutable");
        let error = engine
            .symbol(&item.entry.locator)
            .expect_err("changed source should make the locator stale");
        assert_eq!(error.code, "stale_locator");

        fs::remove_file(temporary).expect("temporary fixture should be removable");
    }
}
