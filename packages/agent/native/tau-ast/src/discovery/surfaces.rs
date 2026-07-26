use super::{
    ApiAccessForm, ApiCallerAccess, ApiCandidate, ApiProvenance, ApiStatus, ApiVisibility,
};
use crate::outline::{LanguageId, OutlineEngine, OutlineFileResult, OutlineRowKind, OutlineTarget};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Component, Path, PathBuf},
    time::Instant,
};

pub(super) fn apply_non_typescript_surfaces(
    engine: &OutlineEngine,
    root: &Path,
    files: &[OutlineFileResult],
    candidates: &mut [ApiCandidate],
    diagnostics: &mut Vec<String>,
    deadline: Instant,
) -> bool {
    let files = files
        .iter()
        .map(|file| (file.path.as_str(), file))
        .collect::<BTreeMap<_, _>>();
    let mut reported = BTreeSet::new();
    let mut rust_module_paths = BTreeMap::<String, Option<String>>::new();
    let mut rust_module_visibility = BTreeMap::<(PathBuf, String), Option<bool>>::new();
    for candidate in candidates
        .iter_mut()
        .filter(|candidate| !matches!(candidate.language, LanguageId::TypeScript | LanguageId::Tsx))
    {
        if Instant::now() >= deadline {
            return true;
        }
        if candidate.language == LanguageId::Markdown {
            candidate.package_surface = ApiStatus::No;
            candidate.internal_only = ApiStatus::Unknown;
            candidate.provenance = ApiProvenance::Unsupported;
            continue;
        }
        if candidate.visibility != ApiVisibility::Public {
            candidate.package_surface = ApiStatus::No;
            candidate.internal_only = ApiStatus::Yes;
            candidate.caller_access = None;
            continue;
        }
        let Some(file) = files.get(candidate.defining_file.as_str()) else {
            continue;
        };
        let resolution = match candidate.language {
            LanguageId::Rust => rust_module_paths
                .entry(candidate.defining_file.clone())
                .or_insert_with(|| {
                    rust_module_path(
                        engine,
                        root,
                        &candidate.defining_file,
                        &mut rust_module_visibility,
                    )
                })
                .as_deref()
                .map(|module_path| rust_access(module_path, candidate)),
            LanguageId::Go => go_access(root, file, candidate),
            LanguageId::Java => java_access(file, candidate),
            LanguageId::Kotlin => kotlin_access(file, candidate),
            LanguageId::CSharp => csharp_access(file, candidate),
            LanguageId::Swift => swift_access(candidate),
            LanguageId::Odin => odin_access(root, file, candidate),
            LanguageId::TypeScript | LanguageId::Tsx | LanguageId::Markdown => None,
        };
        let Some((access, provenance, uncertainty)) = resolution else {
            candidate.package_surface = ApiStatus::Unknown;
            candidate.internal_only = ApiStatus::Unknown;
            candidate.provenance = ApiProvenance::Ambiguous;
            candidate.uncertainty = Some(format!(
                "caller access could not be resolved for this {:?} declaration",
                candidate.language
            ));
            let key = (candidate.language, candidate.defining_file.clone());
            if reported.insert(key) {
                diagnostics.push(format!(
                    "caller access could not be resolved for {}",
                    candidate.defining_file
                ));
            }
            continue;
        };
        candidate.package_surface = ApiStatus::Yes;
        candidate.internal_only = ApiStatus::No;
        candidate.caller_access = Some(access);
        candidate.provenance = provenance;
        candidate.uncertainty = uncertainty;
    }
    Instant::now() >= deadline
}

fn rust_module_path(
    engine: &OutlineEngine,
    root: &Path,
    defining_file: &str,
    module_visibility: &mut BTreeMap<(PathBuf, String), Option<bool>>,
) -> Option<String> {
    let file = Path::new(defining_file);
    let manifest = nearest_manifest(file.parent()?, root, "Cargo.toml")?;
    let source = fs::read_to_string(&manifest).ok()?;
    let crate_name = toml_section_value(&source, "lib", "name")
        .or_else(|| toml_section_value(&source, "package", "name"))?
        .replace('-', "_");
    let package_root = manifest.parent()?;
    let source_root = package_root.join("src");
    let relative = file.strip_prefix(&source_root).ok()?;
    let mut segments = relative
        .components()
        .filter_map(|component| match component {
            Component::Normal(value) => Some(value.to_string_lossy().into_owned()),
            _ => None,
        })
        .collect::<Vec<_>>();
    if let Some(last) = segments.last_mut() {
        *last = last.trim_end_matches(".rs").to_owned();
    }
    if segments
        .last()
        .is_some_and(|segment| matches!(segment.as_str(), "lib" | "main" | "mod"))
    {
        segments.pop();
    }
    if !rust_module_chain_is_public(engine, &source_root, &segments, module_visibility)? {
        return None;
    }
    Some(
        std::iter::once(crate_name)
            .chain(segments)
            .collect::<Vec<_>>()
            .join("::"),
    )
}

fn rust_access(
    module_path: &str,
    candidate: &ApiCandidate,
) -> (ApiCallerAccess, ApiProvenance, Option<String>) {
    let member = candidate.name != candidate.owner_name;
    let imported = if member {
        candidate.owner_name.as_str()
    } else {
        candidate.name.as_str()
    };
    (
        ApiCallerAccess {
            module_path: module_path.to_owned(),
            import_statement: format!("use {module_path}::{imported};"),
            access_expression: if member {
                format!("{}::{}", candidate.access_owner.replace('.', "::"), candidate.name)
            } else {
                candidate.name.clone()
            },
            form: if member {
                ApiAccessForm::Qualified
            } else {
                ApiAccessForm::Direct
            },
        },
        ApiProvenance::Inferred,
        Some(
            "Rust crate and module paths come from Cargo metadata and source layout; public re-export alternatives may also exist"
                .to_owned(),
        ),
    )
}

fn go_access(
    root: &Path,
    file: &OutlineFileResult,
    candidate: &ApiCandidate,
) -> Option<(ApiCallerAccess, ApiProvenance, Option<String>)> {
    let path = Path::new(&candidate.defining_file);
    let manifest = nearest_manifest(path.parent()?, root, "go.mod")?;
    let source = fs::read_to_string(&manifest).ok()?;
    let module = source
        .lines()
        .find_map(|line| line.trim().strip_prefix("module "))?
        .trim();
    let package_root = manifest.parent()?;
    let directory = path.parent()?.strip_prefix(package_root).ok()?;
    let module_path = if directory.as_os_str().is_empty() {
        module.to_owned()
    } else {
        format!("{module}/{}", slash_path(directory))
    };
    let package = package_clause(file, "package")?;
    let member = candidate.name != candidate.owner_name;
    let access_expression = if member {
        if candidate.symbol_type == crate::outline::SymbolType::Method {
            if candidate.signature.trim_start().starts_with("func (")
                && candidate
                    .signature
                    .split_once(')')
                    .is_some_and(|(receiver, _)| receiver.contains('*'))
            {
                format!("(*{package}.{}).{}", candidate.access_owner, candidate.name)
            } else {
                format!("{package}.{}.{}", candidate.access_owner, candidate.name)
            }
        } else {
            format!("{package}.{}.{}", candidate.access_owner, candidate.name)
        }
    } else {
        format!("{package}.{}", candidate.name)
    };
    Some((
        ApiCallerAccess {
            module_path: module_path.clone(),
            import_statement: format!("import {module_path:?}"),
            access_expression,
            form: ApiAccessForm::Qualified,
        },
        ApiProvenance::Exact,
        None,
    ))
}

fn java_access(
    file: &OutlineFileResult,
    candidate: &ApiCandidate,
) -> Option<(ApiCallerAccess, ApiProvenance, Option<String>)> {
    let package = package_clause(file, "package")?;
    let owner = candidate.owner_name.as_str();
    Some((
        ApiCallerAccess {
            module_path: package.clone(),
            import_statement: format!("import {package}.{owner};"),
            access_expression: owner_access(candidate, "."),
            form: access_form(candidate),
        },
        ApiProvenance::Exact,
        None,
    ))
}

fn kotlin_access(
    file: &OutlineFileResult,
    candidate: &ApiCandidate,
) -> Option<(ApiCallerAccess, ApiProvenance, Option<String>)> {
    let package = package_clause(file, "package")?;
    let member = candidate.name != candidate.owner_name;
    let imported = if member {
        candidate.owner_name.as_str()
    } else {
        candidate.name.as_str()
    };
    Some((
        ApiCallerAccess {
            module_path: package.clone(),
            import_statement: format!("import {package}.{imported}"),
            access_expression: owner_access(candidate, "."),
            form: access_form(candidate),
        },
        ApiProvenance::Exact,
        None,
    ))
}

fn csharp_access(
    file: &OutlineFileResult,
    candidate: &ApiCandidate,
) -> Option<(ApiCallerAccess, ApiProvenance, Option<String>)> {
    let namespace = package_clause(file, "namespace")?;
    Some((
        ApiCallerAccess {
            module_path: namespace.clone(),
            import_statement: format!("using {namespace};"),
            access_expression: owner_access(candidate, "."),
            form: access_form(candidate),
        },
        ApiProvenance::Exact,
        None,
    ))
}

fn swift_access(
    candidate: &ApiCandidate,
) -> Option<(ApiCallerAccess, ApiProvenance, Option<String>)> {
    let components = Path::new(&candidate.defining_file)
        .components()
        .filter_map(|component| match component {
            Component::Normal(value) => Some(value.to_string_lossy().into_owned()),
            _ => None,
        })
        .collect::<Vec<_>>();
    let sources = components
        .iter()
        .position(|component| component == "Sources")?;
    let module = components.get(sources + 1)?.clone();
    Some((
        ApiCallerAccess {
            module_path: module.clone(),
            import_statement: format!("import {module}"),
            access_expression: owner_access(candidate, "."),
            form: access_form(candidate),
        },
        ApiProvenance::Inferred,
        Some("Swift module name is inferred from the Sources/<Target> package layout".to_owned()),
    ))
}

fn odin_access(
    root: &Path,
    file: &OutlineFileResult,
    candidate: &ApiCandidate,
) -> Option<(ApiCallerAccess, ApiProvenance, Option<String>)> {
    let package = package_clause(file, "package")?;
    let directory = Path::new(&candidate.defining_file).parent()?;
    let relative = directory.strip_prefix(root).ok()?;
    let module_path = if relative.as_os_str().is_empty() {
        package.clone()
    } else {
        slash_path(relative)
    };
    Some((
        ApiCallerAccess {
            module_path: module_path.clone(),
            import_statement: format!("import {package} {module_path:?}"),
            access_expression: format!("{package}.{}", candidate.name),
            form: ApiAccessForm::Qualified,
        },
        ApiProvenance::Inferred,
        Some(
            "Odin import path is repository-relative because collection mappings are not available from source"
                .to_owned(),
        ),
    ))
}

fn package_clause(file: &OutlineFileResult, keyword: &str) -> Option<String> {
    let signature = &file
        .items
        .iter()
        .find(|item| item.row_kind == OutlineRowKind::Package)?
        .entry
        .signature;
    let value = package_value(signature, keyword)?;
    (!value.is_empty()).then(|| value.to_owned())
}

fn package_value<'a>(signature: &'a str, keyword: &str) -> Option<&'a str> {
    signature
        .trim()
        .strip_prefix(keyword)?
        .trim()
        .split([';', '{', '\n', '\r'])
        .next()
        .map(str::trim)
}

fn owner_access(candidate: &ApiCandidate, separator: &str) -> String {
    if candidate.name == candidate.owner_name {
        candidate.name.clone()
    } else {
        format!("{}{separator}{}", candidate.access_owner, candidate.name)
    }
}

fn rust_module_chain_is_public(
    engine: &OutlineEngine,
    source_root: &Path,
    segments: &[String],
    module_visibility: &mut BTreeMap<(PathBuf, String), Option<bool>>,
) -> Option<bool> {
    let mut directory = source_root.to_path_buf();
    let mut parent_file = [source_root.join("lib.rs"), source_root.join("main.rs")]
        .into_iter()
        .find(|path| path.is_file())?;
    for segment in segments {
        let cache_key = (parent_file.clone(), segment.clone());
        let is_public = if let Some(cached) = module_visibility.get(&cache_key) {
            *cached
        } else {
            let resolved = engine
                .outline(
                    OutlineTarget::File {
                        path: parent_file.to_string_lossy().into_owned(),
                        language: LanguageId::Rust,
                    },
                    true,
                    false,
                    std::slice::from_ref(segment),
                )
                .ok()
                .and_then(|outlined| {
                    outlined.files.first().and_then(|file| {
                        file.items
                            .iter()
                            .find(|item| {
                                item.row_kind == OutlineRowKind::Declaration
                                    && item.entry.ast_kind == "mod_item"
                                    && item.entry.name == *segment
                            })
                            .map(|declaration| declaration.is_exported)
                    })
                });
            module_visibility.insert(cache_key, resolved);
            resolved
        }?;
        if !is_public {
            return Some(false);
        }
        directory.push(segment);
        parent_file = if directory.with_extension("rs").is_file() {
            directory.with_extension("rs")
        } else {
            directory.join("mod.rs")
        };
    }
    Some(true)
}

fn access_form(candidate: &ApiCandidate) -> ApiAccessForm {
    if candidate.name == candidate.owner_name {
        ApiAccessForm::Direct
    } else {
        ApiAccessForm::Qualified
    }
}

fn nearest_manifest(start: &Path, root: &Path, name: &str) -> Option<PathBuf> {
    let mut directory = Some(start);
    while let Some(current) = directory {
        if !current.starts_with(root) {
            return None;
        }
        let manifest = current.join(name);
        if manifest.is_file() {
            return Some(manifest);
        }
        if current == root {
            return None;
        }
        directory = current.parent();
    }
    None
}

fn toml_section_value(source: &str, wanted_section: &str, wanted_key: &str) -> Option<String> {
    let mut section = "";
    for line in source.lines() {
        let line = line.split('#').next()?.trim();
        if let Some(value) = line
            .strip_prefix('[')
            .and_then(|line| line.strip_suffix(']'))
        {
            section = value.trim();
            continue;
        }
        if section != wanted_section {
            continue;
        }
        let (key, value) = line.split_once('=')?;
        if key.trim() == wanted_key {
            return Some(value.trim().trim_matches(['\'', '"']).to_owned());
        }
    }
    None
}

fn slash_path(path: &Path) -> String {
    path.components()
        .filter_map(|component| match component {
            Component::Normal(value) => Some(value.to_string_lossy()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/")
}

#[cfg(test)]
mod tests {
    use super::package_value;

    #[test]
    fn extracts_block_and_file_scoped_package_clauses() {
        assert_eq!(
            package_value(
                "namespace Avalonia.Animation\n{\n    public class Animatable {}\n}",
                "namespace"
            ),
            Some("Avalonia.Animation")
        );
        assert_eq!(
            package_value("namespace Fixture.Parsing;", "namespace"),
            Some("Fixture.Parsing")
        );
    }
}
