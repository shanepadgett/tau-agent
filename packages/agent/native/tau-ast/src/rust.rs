use crate::{
    outline::{
        EntryRole, OutlineEntry, OutlineItem, OutlineMember, OutlineRowKind, ParseCertainty,
        SourceRange, SymbolType,
    },
    source::{certainty, certainty_reason, dedent, indent, source_range},
};
use ast_grep_core::Node;
use std::collections::BTreeSet;

pub fn extract_rust_items<D: ast_grep_core::Doc>(
    root: Node<D>,
    source: &str,
    include_docs: bool,
) -> Vec<OutlineItem> {
    let recovery_ranges = root
        .dfs()
        .filter(|node| node.is_error() || node.is_missing())
        .map(|node| node.range())
        .collect::<Vec<_>>();
    let exported_types = root
        .children()
        .filter(|node| {
            matches!(
                node.kind().as_ref(),
                "struct_item" | "union_item" | "enum_item" | "trait_item" | "type_item"
            ) && is_public(node)
        })
        .filter_map(|node| node.field("name").map(|name| name.text().into_owned()))
        .collect::<BTreeSet<_>>();
    let declared_types = root
        .children()
        .filter(|node| {
            matches!(
                node.kind().as_ref(),
                "struct_item" | "union_item" | "enum_item" | "trait_item" | "type_item"
            )
        })
        .filter_map(|node| node.field("name").map(|name| name.text().into_owned()))
        .collect::<BTreeSet<_>>();
    let mut reexported_names = BTreeSet::new();
    for declaration in root
        .children()
        .filter(|node| node.kind() == "use_declaration" && is_public(node))
    {
        if let Some(argument) = declaration.field("argument") {
            let mut conservative = false;
            collect_use_bindings(argument, &[], &mut reexported_names, &mut conservative);
        }
    }
    let mut items = Vec::new();

    for node in root.children().filter(|node| node.is_named()) {
        match node.kind().as_ref() {
            "line_comment" | "block_comment" | "attribute_item" | "inner_attribute_item" => {}
            "use_declaration" | "extern_crate_declaration" => items.push(structural_item(
                node.clone(),
                source,
                if is_public(&node) {
                    OutlineRowKind::Export
                } else {
                    OutlineRowKind::Import
                },
                SymbolType::Module,
            )),
            "mod_item" => {
                if let Some(mut item) = container_item(
                    node,
                    source,
                    &recovery_ranges,
                    SymbolType::Namespace,
                    &exported_types,
                    include_docs,
                ) {
                    for member in &mut item.members {
                        if reexported_names.contains(&member.entry.name) {
                            member.is_public = true;
                            item.is_exported = true;
                        }
                    }
                    items.push(item);
                }
            }
            "struct_item" | "union_item" => {
                if let Some(item) = container_item(
                    node,
                    source,
                    &recovery_ranges,
                    SymbolType::Struct,
                    &exported_types,
                    include_docs,
                ) {
                    items.push(item);
                }
            }
            "enum_item" => {
                if let Some(item) = container_item(
                    node,
                    source,
                    &recovery_ranges,
                    SymbolType::Enum,
                    &exported_types,
                    include_docs,
                ) {
                    items.push(item);
                }
            }
            "trait_item" => {
                if let Some(item) = container_item(
                    node,
                    source,
                    &recovery_ranges,
                    SymbolType::Interface,
                    &exported_types,
                    include_docs,
                ) {
                    items.push(item);
                }
            }
            "impl_item" => {
                if let Some(item) = impl_item(
                    node,
                    source,
                    &recovery_ranges,
                    &declared_types,
                    &exported_types,
                ) {
                    items.push(item);
                }
            }
            "foreign_mod_item" => {
                if let Some(item) = foreign_item(node, source, &recovery_ranges) {
                    items.push(item);
                }
            }
            "function_item" | "function_signature_item" => {
                if let Some(item) =
                    simple_item(node, source, &recovery_ranges, SymbolType::Function)
                {
                    items.push(item);
                }
            }
            "type_item" | "associated_type" => {
                if let Some(item) =
                    simple_item(node, source, &recovery_ranges, SymbolType::TypeParameter)
                {
                    items.push(item);
                }
            }
            "const_item" => {
                if let Some(item) =
                    simple_item(node, source, &recovery_ranges, SymbolType::Constant)
                {
                    items.push(item);
                }
            }
            "static_item" => {
                if let Some(item) =
                    simple_item(node, source, &recovery_ranges, SymbolType::Variable)
                {
                    items.push(item);
                }
            }
            "macro_definition" => {
                if let Some(item) = macro_item(node, source, &recovery_ranges) {
                    items.push(item);
                }
            }
            "macro_invocation" | "expression_statement" => items.push(structural_item(
                node,
                source,
                OutlineRowKind::SideEffect,
                SymbolType::Event,
            )),
            _ => {}
        }
    }

    for item in &mut items {
        if item.row_kind != OutlineRowKind::Declaration {
            continue;
        }
        if !include_docs {
            item.entry.signature = without_rust_docs(&item.entry.signature);
            for member in &mut item.members {
                member.entry.signature = without_rust_docs(&member.entry.signature);
            }
        }
    }
    items
}

pub fn filter_rust_items<D: ast_grep_core::Doc>(
    root: Node<D>,
    source: &str,
    items: &mut Vec<OutlineItem>,
    include_private: bool,
    names: &[String],
) {
    let names = names.iter().map(String::as_str).collect::<BTreeSet<_>>();
    if names.is_empty() {
        items.retain_mut(|item| {
            if item.row_kind != OutlineRowKind::Declaration {
                return true;
            }
            item.members
                .retain(|member| include_private || member.is_public);
            include_private || item.is_exported
        });
        return;
    }

    let mut selected_ranges = Vec::new();
    items.retain_mut(|item| match item.row_kind {
        OutlineRowKind::Package => true,
        OutlineRowKind::Import | OutlineRowKind::Export | OutlineRowKind::SideEffect => false,
        OutlineRowKind::Declaration => {
            let visible = include_private || item.is_exported;
            let item_matches = visible
                && (names.contains(item.entry.name.as_str())
                    || names.contains(item.entry.qualified_name.as_str()));
            item.members.retain(|member| {
                let container_matches =
                    member
                        .entry
                        .qualified_name
                        .rsplit_once('.')
                        .is_some_and(|(container, _)| {
                            names.contains(container)
                                || container
                                    .rsplit('.')
                                    .next()
                                    .is_some_and(|name| names.contains(name))
                        });
                visible
                    && (include_private || member.is_public)
                    && (item_matches
                        || container_matches
                        || names.contains(member.entry.name.as_str())
                        || names.contains(member.entry.qualified_name.as_str()))
            });
            let selected = item_matches || !item.members.is_empty();
            if selected {
                selected_ranges.push(item.entry.range.clone());
            }
            selected
        }
    });

    let used_names = used_rust_names(root.clone(), &selected_ranges);
    let import_starts = root
        .children()
        .filter(|node| {
            matches!(
                node.kind().as_ref(),
                "use_declaration" | "extern_crate_declaration"
            )
        })
        .filter(|node| rust_import_is_used(node.clone(), &used_names))
        .map(|node| node.range().start)
        .collect::<BTreeSet<_>>();
    for node in root.children().filter(|node| {
        matches!(
            node.kind().as_ref(),
            "use_declaration" | "extern_crate_declaration"
        ) && import_starts.contains(&node.range().start)
    }) {
        items.push(structural_item(
            node.clone(),
            source,
            if is_public(&node) {
                OutlineRowKind::Export
            } else {
                OutlineRowKind::Import
            },
            SymbolType::Module,
        ));
    }
    items.sort_by_key(|item| item.entry.range.start_byte);
}

pub fn finalize_rust_signatures(items: &mut [OutlineItem]) {
    for item in items {
        if item.row_kind != OutlineRowKind::Declaration
            || !matches!(
                item.entry.symbol_type,
                SymbolType::Namespace
                    | SymbolType::Struct
                    | SymbolType::Enum
                    | SymbolType::Interface
                    | SymbolType::Class
            )
            || item.entry.body_range.is_none()
        {
            continue;
        }
        let raw_header = item.entry.signature.trim_end();
        let (header, tuple_suffix) = raw_header
            .split_once('\0')
            .map_or((raw_header, None), |(header, suffix)| {
                (header, Some(suffix))
            });
        let tuple = header.ends_with('(');
        if item.members.is_empty() {
            item.entry.signature = if tuple {
                format!("{header}){}", tuple_suffix.unwrap_or(";"))
            } else {
                format!("{header}}}")
            };
            continue;
        }
        let members = item
            .members
            .iter()
            .map(|member| {
                let signature = if tuple {
                    format!("{},", member.entry.signature)
                } else {
                    member.entry.signature.clone()
                };
                indent(&signature)
            })
            .collect::<Vec<_>>()
            .join("\n");
        item.entry.signature = if tuple {
            format!("{header}\n{members}\n){}", tuple_suffix.unwrap_or(";"))
        } else {
            format!("{header}\n{members}\n}}")
        };
    }
}

pub fn matching_rust_imports<'a, D: ast_grep_core::Doc>(
    root: Node<D>,
    source: &'a str,
    declaration: &SourceRange,
) -> Vec<&'a str> {
    let used_names = used_rust_names(root.clone(), std::slice::from_ref(declaration));
    root.dfs()
        .filter(|node| {
            matches!(
                node.kind().as_ref(),
                "use_declaration" | "extern_crate_declaration"
            )
        })
        .filter(|node| import_scope_contains(node.clone(), declaration))
        .filter(|node| {
            let bytes = node.range();
            bytes.end <= declaration.start_byte || bytes.start >= declaration.end_byte
        })
        .filter(|node| rust_import_is_used(node.clone(), &used_names))
        .map(|node| {
            let range = node.range();
            let start = attached_start(node, source).unwrap_or(range.start);
            &source[start..range.end]
        })
        .collect()
}

fn import_scope_contains<D: ast_grep_core::Doc>(
    import: Node<D>,
    declaration: &SourceRange,
) -> bool {
    let mut parent = import.parent();
    while let Some(scope) = parent {
        if matches!(scope.kind().as_ref(), "declaration_list" | "source_file") {
            let range = scope.range();
            return declaration.start_byte >= range.start && declaration.end_byte <= range.end;
        }
        parent = scope.parent();
    }
    false
}

fn container_item<D: ast_grep_core::Doc>(
    node: Node<D>,
    source: &str,
    recovery_ranges: &[std::ops::Range<usize>],
    symbol_type: SymbolType,
    exported_types: &BTreeSet<String>,
    include_docs: bool,
) -> Option<OutlineItem> {
    let name_node = node.field("name")?;
    let name = name_node.text().into_owned();
    let public = is_public(&node);
    let body = node.field("body");
    let members = body.as_ref().map_or_else(Vec::new, |body| {
        container_members(
            body.clone(),
            source,
            recovery_ranges,
            &name,
            public,
            node.kind().as_ref(),
            exported_types,
            include_docs,
        )
    });
    Some(outline_item(
        node.clone(),
        name_node,
        name.clone(),
        name,
        source,
        recovery_ranges,
        symbol_type,
        public,
        body,
        members,
    ))
}

fn impl_item<D: ast_grep_core::Doc>(
    node: Node<D>,
    source: &str,
    recovery_ranges: &[std::ops::Range<usize>],
    declared_types: &BTreeSet<String>,
    exported_types: &BTreeSet<String>,
) -> Option<OutlineItem> {
    let type_node = node.field("type")?;
    let name_node = type_name_node(type_node.clone()).unwrap_or_else(|| type_node.clone());
    let target_binding = name_node.text().trim().to_owned();
    let name = type_node.text().trim().to_owned();
    let trait_node = node.field("trait");
    let trait_name = trait_node
        .as_ref()
        .map(|trait_node| trait_node.text().trim().to_owned());
    let qualified_name = trait_name.as_ref().map_or_else(
        || name.clone(),
        |trait_name| format!("{name} as {trait_name}"),
    );
    let target_public =
        !declared_types.contains(&target_binding) || exported_types.contains(&target_binding);
    let trait_public = trait_node
        .as_ref()
        .and_then(|trait_node| type_name_node(trait_node.clone()))
        .is_none_or(|trait_name| {
            let trait_name = trait_name.text();
            !declared_types.contains(trait_name.trim())
                || exported_types.contains(trait_name.trim())
        });
    let public = target_public && trait_public;
    let body = node.field("body");
    let members = body.as_ref().map_or_else(Vec::new, |body| {
        body.children()
            .filter_map(|member| {
                member_item(
                    member,
                    source,
                    recovery_ranges,
                    &name,
                    public && trait_node.is_some(),
                    body.range(),
                    exported_types,
                )
            })
            .collect()
    });
    Some(outline_item(
        node,
        name_node,
        name,
        qualified_name,
        source,
        recovery_ranges,
        SymbolType::Class,
        public,
        body,
        members,
    ))
}

fn foreign_item<D: ast_grep_core::Doc>(
    node: Node<D>,
    source: &str,
    recovery_ranges: &[std::ops::Range<usize>],
) -> Option<OutlineItem> {
    let name_node = node
        .children()
        .find(|child| child.kind() == "extern_modifier")?;
    let name = name_node.text().trim().to_owned();
    let body = node.field("body").or_else(|| {
        node.children()
            .find(|child| child.kind() == "declaration_list")
    });
    let public = is_public(&node);
    let members = body.as_ref().map_or_else(Vec::new, |body| {
        body.children()
            .filter_map(|member| {
                member_item(
                    member,
                    source,
                    recovery_ranges,
                    &name,
                    public,
                    body.range(),
                    &BTreeSet::new(),
                )
            })
            .collect()
    });
    let public = public || members.iter().any(|member| member.is_public);
    Some(outline_item(
        node,
        name_node,
        name.clone(),
        name,
        source,
        recovery_ranges,
        SymbolType::Namespace,
        public,
        body,
        members,
    ))
}

fn simple_item<D: ast_grep_core::Doc>(
    node: Node<D>,
    source: &str,
    recovery_ranges: &[std::ops::Range<usize>],
    symbol_type: SymbolType,
) -> Option<OutlineItem> {
    let name_node = node.field("name")?;
    let name = name_node.text().into_owned();
    let body = node.field("body").or_else(|| node.field("value"));
    Some(outline_item(
        node,
        name_node,
        name.clone(),
        name,
        source,
        recovery_ranges,
        symbol_type,
        false,
        body,
        Vec::new(),
    ))
}

fn macro_item<D: ast_grep_core::Doc>(
    node: Node<D>,
    source: &str,
    recovery_ranges: &[std::ops::Range<usize>],
) -> Option<OutlineItem> {
    let name_node = node.field("name")?;
    let name = name_node.text().into_owned();
    let public = has_macro_export(node.clone(), source);
    let node_range = node.range();
    let body_bytes = macro_body_bytes(node.clone());
    let start_byte = attached_start(node.clone(), source).unwrap_or(node_range.start);
    let mut item = outline_item(
        node.clone(),
        name_node,
        name.clone(),
        name,
        source,
        recovery_ranges,
        SymbolType::Function,
        public,
        None,
        Vec::new(),
    );
    if let Some(body_bytes) = body_bytes {
        let prefix =
            source_without_attached_comments(node.clone(), source, start_byte, body_bytes.start);
        let prefix = prefix.trim_end();
        let opener = source[body_bytes.start..body_bytes.end]
            .chars()
            .next()
            .unwrap_or('{');
        let closing = match opener {
            '(' => ')',
            '[' => ']',
            _ => '}',
        };
        let suffix = source[body_bytes.end..node_range.end].trim();
        item.entry.signature = format!("{prefix} {opener} … {closing}{suffix}");
        item.entry.body_range = Some(source_range(source.as_bytes(), body_bytes));
    }
    Some(item)
}

#[allow(clippy::too_many_arguments)]
fn outline_item<D: ast_grep_core::Doc>(
    node: Node<D>,
    name_node: Node<D>,
    name: String,
    qualified_name: String,
    source: &str,
    recovery_ranges: &[std::ops::Range<usize>],
    symbol_type: SymbolType,
    public_override: bool,
    body: Option<Node<D>>,
    members: Vec<OutlineMember>,
) -> OutlineItem {
    let node_range = node.range();
    let start_byte = attached_start(node.clone(), source).unwrap_or(node_range.start);
    let declaration_range = start_byte..node_range.end;
    let ownership = node_range.clone();
    let item_certainty = certainty(recovery_ranges, &declaration_range, &ownership);
    let signature = item_signature(node.clone(), body.as_ref(), source, start_byte, symbol_type);
    OutlineItem {
        entry: OutlineEntry {
            role: EntryRole::Item,
            symbol_type,
            name,
            qualified_name,
            range: source_range(source.as_bytes(), declaration_range),
            name_range: source_range(source.as_bytes(), name_node.range()),
            receiver_range: None,
            body_range: body
                .as_ref()
                .map(|body| source_range(source.as_bytes(), body.range())),
            signature,
            ast_kind: node.kind().into_owned(),
            certainty: item_certainty,
            certainty_reason: certainty_reason(item_certainty),
            locator: None,
        },
        row_kind: OutlineRowKind::Declaration,
        is_import: false,
        is_exported: public_override || is_public(&node),
        members,
    }
}

#[allow(clippy::too_many_arguments)]
fn container_members<D: ast_grep_core::Doc>(
    body: Node<D>,
    source: &str,
    recovery_ranges: &[std::ops::Range<usize>],
    parent_name: &str,
    parent_public: bool,
    parent_kind: &str,
    exported_types: &BTreeSet<String>,
    include_docs: bool,
) -> Vec<OutlineMember> {
    if body.kind() == "ordered_field_declaration_list" {
        return positional_members(body, source, recovery_ranges, parent_name, include_docs);
    }
    let ownership = body.range();
    if parent_kind == "mod_item" {
        let local_public = body
            .children()
            .filter(|member| is_public(member))
            .filter_map(|member| member.field("name").map(|name| name.text().into_owned()))
            .collect::<BTreeSet<_>>();
        let mut members = Vec::new();
        for member in body.children() {
            if member.kind() != "impl_item" {
                if let Some(member) = member_item(
                    member,
                    source,
                    recovery_ranges,
                    parent_name,
                    false,
                    ownership.clone(),
                    exported_types,
                ) {
                    members.push(member);
                }
                continue;
            }
            let Some(target) = member.field("type") else {
                continue;
            };
            let target_name = target.text().trim().to_owned();
            let target_binding = type_name_node(target)
                .map(|name| name.text().into_owned())
                .unwrap_or_else(|| target_name.clone());
            let target_public = parent_public && local_public.contains(&target_binding);
            let trait_impl = member.field("trait").is_some();
            let Some(impl_body) = member.field("body") else {
                continue;
            };
            let qualified_parent = format!("{parent_name}.{target_name}");
            for implementation_member in impl_body.children() {
                if let Some(mut implementation_member) = member_item(
                    implementation_member,
                    source,
                    recovery_ranges,
                    &qualified_parent,
                    target_public && trait_impl,
                    impl_body.range(),
                    exported_types,
                ) {
                    implementation_member.is_public &= target_public;
                    members.push(implementation_member);
                }
            }
        }
        return members;
    }
    body.children()
        .filter_map(|member| {
            if member.kind() == "enum_variant" {
                return named_member(
                    member,
                    source,
                    recovery_ranges,
                    parent_name,
                    SymbolType::EnumMember,
                    parent_public,
                    ownership.clone(),
                );
            }
            let inherited_public = parent_kind == "trait_item" && parent_public;
            member_item(
                member,
                source,
                recovery_ranges,
                parent_name,
                inherited_public,
                ownership.clone(),
                exported_types,
            )
        })
        .collect()
}

fn member_item<D: ast_grep_core::Doc>(
    member: Node<D>,
    source: &str,
    recovery_ranges: &[std::ops::Range<usize>],
    parent_name: &str,
    inherited_public: bool,
    ownership: std::ops::Range<usize>,
    _exported_types: &BTreeSet<String>,
) -> Option<OutlineMember> {
    let symbol_type = match member.kind().as_ref() {
        "field_declaration" => SymbolType::Field,
        "function_item" | "function_signature_item" => SymbolType::Method,
        "associated_type" | "type_item" => SymbolType::TypeParameter,
        "const_item" => SymbolType::Constant,
        "static_item" => SymbolType::Variable,
        "struct_item" | "union_item" => SymbolType::Struct,
        "enum_item" => SymbolType::Enum,
        "trait_item" => SymbolType::Interface,
        "mod_item" => SymbolType::Namespace,
        "macro_definition" => SymbolType::Function,
        _ => return None,
    };
    named_member(
        member,
        source,
        recovery_ranges,
        parent_name,
        symbol_type,
        inherited_public,
        ownership,
    )
}

fn named_member<D: ast_grep_core::Doc>(
    member: Node<D>,
    source: &str,
    recovery_ranges: &[std::ops::Range<usize>],
    parent_name: &str,
    symbol_type: SymbolType,
    public_override: bool,
    ownership: std::ops::Range<usize>,
) -> Option<OutlineMember> {
    let name_node = member.field("name")?;
    let name = name_node.text().into_owned();
    let member_range = member.range();
    let start_byte = attached_start(member.clone(), source)
        .filter(|start| *start >= ownership.start)
        .unwrap_or(member_range.start);
    let declaration_range = start_byte..member_range.end;
    let mut body_bytes = None;
    let body = if member.kind() == "macro_definition" {
        body_bytes = macro_body_bytes(member.clone());
        None
    } else {
        member.field("body").or_else(|| member.field("value"))
    };
    let member_certainty = certainty(recovery_ranges, &declaration_range, &ownership);
    Some(OutlineMember {
        entry: OutlineEntry {
            role: EntryRole::Member,
            symbol_type,
            name: name.clone(),
            qualified_name: format!("{parent_name}.{name}"),
            range: source_range(source.as_bytes(), declaration_range),
            name_range: source_range(source.as_bytes(), name_node.range()),
            receiver_range: None,
            body_range: body_bytes
                .clone()
                .or_else(|| body.as_ref().map(Node::range))
                .map(|body| source_range(source.as_bytes(), body)),
            signature: if let Some(body_bytes) = body_bytes {
                let prefix = source_without_attached_comments(
                    member.clone(),
                    source,
                    start_byte,
                    body_bytes.start,
                );
                let prefix = prefix.trim_end();
                let opener = source[body_bytes.start..body_bytes.end]
                    .chars()
                    .next()
                    .unwrap_or('{');
                let closing = match opener {
                    '(' => ')',
                    '[' => ']',
                    _ => '}',
                };
                let suffix = source[body_bytes.end..member_range.end].trim();
                format!("{prefix} {opener} … {closing}{suffix}")
            } else {
                member_signature(
                    member.clone(),
                    body.as_ref(),
                    source,
                    start_byte,
                    symbol_type,
                )
            },
            ast_kind: member.kind().into_owned(),
            certainty: member_certainty,
            certainty_reason: certainty_reason(member_certainty),
            locator: None,
        },
        is_public: public_override || is_public(&member),
    })
}

fn positional_members<D: ast_grep_core::Doc>(
    body: Node<D>,
    source: &str,
    recovery_ranges: &[std::ops::Range<usize>],
    parent_name: &str,
    include_docs: bool,
) -> Vec<OutlineMember> {
    let ownership = body.range();
    let mut visibility = None;
    let mut attached = None;
    let mut signature_parts = Vec::new();
    let mut members = Vec::new();
    for child in body.children().filter(|child| child.is_named()) {
        match child.kind().as_ref() {
            "visibility_modifier" => {
                attached.get_or_insert(child.range().start);
                visibility = Some(child.clone());
                signature_parts.push(child.text().trim().to_owned());
            }
            "attribute_item" => {
                attached.get_or_insert(child.range().start);
                signature_parts.push(child.text().trim().to_owned());
            }
            "line_comment" | "block_comment" => {
                attached.get_or_insert(child.range().start);
                if include_docs {
                    signature_parts.push(child.text().trim().to_owned());
                }
            }
            _ => {
                let index = members.len();
                let name = index.to_string();
                let start = attached.take().unwrap_or(child.range().start);
                let declaration_range = start..child.range().end;
                let member_certainty = certainty(recovery_ranges, &declaration_range, &ownership);
                signature_parts.push(child.text().trim().to_owned());
                let field_source = signature_parts.join("\n");
                members.push(OutlineMember {
                    entry: OutlineEntry {
                        role: EntryRole::Member,
                        symbol_type: SymbolType::Field,
                        name: name.clone(),
                        qualified_name: format!("{parent_name}.{name}"),
                        range: source_range(source.as_bytes(), declaration_range),
                        name_range: source_range(source.as_bytes(), child.range()),
                        receiver_range: None,
                        body_range: None,
                        signature: format!("{name}: {field_source}"),
                        ast_kind: child.kind().into_owned(),
                        certainty: member_certainty,
                        certainty_reason: certainty_reason(member_certainty),
                        locator: None,
                    },
                    is_public: visibility.as_ref().is_some_and(is_public_modifier),
                });
                visibility = None;
                signature_parts.clear();
            }
        }
    }
    members
}

fn item_signature<D: ast_grep_core::Doc>(
    node: Node<D>,
    body: Option<&Node<D>>,
    source: &str,
    start_byte: usize,
    symbol_type: SymbolType,
) -> String {
    let Some(body) = body else {
        return source_without_attached_comments(
            node.clone(),
            source,
            start_byte,
            node.range().end,
        )
        .trim()
        .to_owned();
    };
    if node.kind() == "macro_definition" {
        let prefix =
            source_without_attached_comments(node.clone(), source, start_byte, body.range().start);
        let prefix = prefix.trim_end();
        return format!("{prefix} {{ … }}");
    }
    if matches!(symbol_type, SymbolType::Constant | SymbolType::Variable) {
        let prefix =
            source_without_attached_comments(node.clone(), source, start_byte, body.range().start);
        let prefix = prefix.trim_end();
        return format!("{prefix} …;");
    }
    if matches!(symbol_type, SymbolType::Function | SymbolType::Method) {
        return source_without_attached_comments(node, source, start_byte, body.range().start)
            .trim_end()
            .to_owned();
    }
    let raw_prefix = &source[start_byte..body.range().start];
    let rendered_prefix =
        source_without_attached_comments(node.clone(), source, start_byte, body.range().start);
    let prefix = rendered_prefix.trim_end();
    let separator = if opener_at(body, source) == Some('(') {
        ""
    } else if raw_prefix[raw_prefix.trim_end().len()..].contains('\n') {
        "\n"
    } else {
        " "
    };
    let opener = opener_at(body, source);
    match opener {
        Some('(') => format!(
            "{prefix}{separator}(\0{}",
            source[body.range().end..node.range().end].trim_end()
        ),
        Some(opener) => format!("{prefix}{separator}{opener}"),
        None => prefix.to_owned(),
    }
}

fn member_signature<D: ast_grep_core::Doc>(
    node: Node<D>,
    body: Option<&Node<D>>,
    source: &str,
    start_byte: usize,
    symbol_type: SymbolType,
) -> String {
    let column = node.start_pos().column(&node);
    let Some(body) = body else {
        let signature =
            source_without_attached_comments(node.clone(), source, start_byte, node.range().end);
        return dedent(signature.trim(), column);
    };
    if matches!(symbol_type, SymbolType::Constant | SymbolType::Variable) {
        let prefix =
            source_without_attached_comments(node.clone(), source, start_byte, body.range().start);
        let prefix = prefix.trim_end();
        return dedent(&format!("{prefix} …;"), column);
    }
    if matches!(symbol_type, SymbolType::Function | SymbolType::Method) {
        let signature =
            source_without_attached_comments(node.clone(), source, start_byte, body.range().start);
        return dedent(signature.trim_end(), column);
    }
    if matches!(
        symbol_type,
        SymbolType::Namespace | SymbolType::Struct | SymbolType::Enum | SymbolType::Interface
    ) {
        let raw_prefix = &source[start_byte..body.range().start];
        let rendered_prefix =
            source_without_attached_comments(node.clone(), source, start_byte, body.range().start);
        let prefix = rendered_prefix.trim_end();
        let opener = opener_at(body, source);
        let separator = if opener == Some('(') {
            ""
        } else if raw_prefix[raw_prefix.trim_end().len()..].contains('\n') {
            "\n"
        } else {
            " "
        };
        let signature = match opener {
            Some('(') => format!("{prefix}{separator}( … );"),
            Some('{') => format!("{prefix}{separator}{{ … }}"),
            _ => prefix.to_owned(),
        };
        return dedent(&signature, column);
    }
    let signature =
        source_without_attached_comments(node.clone(), source, start_byte, node.range().end);
    dedent(signature.trim(), column)
}

fn opener_at<D: ast_grep_core::Doc>(body: &Node<D>, source: &str) -> Option<char> {
    source[body.range().start..body.range().end]
        .chars()
        .next()
        .filter(|opener| matches!(opener, '{' | '('))
}

fn macro_body_bytes<D: ast_grep_core::Doc>(node: Node<D>) -> Option<std::ops::Range<usize>> {
    let opener = node
        .children()
        .find(|child| matches!(child.kind().as_ref(), "{" | "(" | "["))?;
    let closing = match opener.kind().as_ref() {
        "{" => "}",
        "(" => ")",
        "[" => "]",
        _ => return None,
    };
    let start = opener.range().start;
    let end = node
        .children()
        .filter(|child| child.kind() == closing)
        .last()?
        .range()
        .end;
    Some(start..end)
}

fn structural_item<D: ast_grep_core::Doc>(
    node: Node<D>,
    source: &str,
    row_kind: OutlineRowKind,
    symbol_type: SymbolType,
) -> OutlineItem {
    let bytes = node.range();
    let signature = source[bytes.clone()].trim().to_owned();
    let range = source_range(source.as_bytes(), bytes);
    let name = if row_kind == OutlineRowKind::SideEffect {
        node.kind().replace('_', " ")
    } else {
        import_display_name(node.clone())
    };
    OutlineItem {
        entry: OutlineEntry {
            role: EntryRole::Item,
            symbol_type,
            name: name.clone(),
            qualified_name: name,
            range: range.clone(),
            name_range: range,
            receiver_range: None,
            body_range: None,
            signature,
            ast_kind: node.kind().into_owned(),
            certainty: ParseCertainty::Certain,
            certainty_reason: None,
            locator: None,
        },
        row_kind,
        is_import: row_kind == OutlineRowKind::Import,
        is_exported: row_kind == OutlineRowKind::Export,
        members: Vec::new(),
    }
}

fn import_display_name<D: ast_grep_core::Doc>(node: Node<D>) -> String {
    if node.kind() == "extern_crate_declaration" {
        return node
            .field("alias")
            .or_else(|| node.field("name"))
            .map(|name| name.text().into_owned())
            .unwrap_or_else(|| "extern crate".to_owned());
    }
    "use".to_owned()
}

fn used_rust_names<D: ast_grep_core::Doc>(
    root: Node<D>,
    ranges: &[SourceRange],
) -> BTreeSet<String> {
    root.dfs()
        .filter(|node| {
            matches!(
                node.kind().as_ref(),
                "identifier" | "type_identifier" | "field_identifier"
            )
        })
        .filter(|node| {
            let bytes = node.range();
            ranges
                .iter()
                .any(|range| bytes.start >= range.start_byte && bytes.end <= range.end_byte)
        })
        .map(|node| node.text().into_owned())
        .collect()
}

fn rust_import_is_used<D: ast_grep_core::Doc>(
    declaration: Node<D>,
    used_names: &BTreeSet<String>,
) -> bool {
    let mut bindings = BTreeSet::new();
    let mut conservative = false;
    if declaration.kind() == "extern_crate_declaration" {
        if let Some(binding) = declaration
            .field("alias")
            .or_else(|| declaration.field("name"))
        {
            bindings.insert(binding.text().into_owned());
        }
    } else if let Some(argument) = declaration.field("argument") {
        collect_use_bindings(argument, &[], &mut bindings, &mut conservative);
    }
    conservative
        || bindings.iter().any(|binding| {
            used_names.contains(binding) || binding.chars().next().is_some_and(char::is_uppercase)
        })
}

fn collect_use_bindings<D: ast_grep_core::Doc>(
    node: Node<D>,
    prefix: &[String],
    bindings: &mut BTreeSet<String>,
    conservative: &mut bool,
) {
    match node.kind().as_ref() {
        "use_as_clause" => {
            if let Some(alias) = node.field("alias") {
                let alias = alias.text().into_owned();
                if alias == "_" {
                    *conservative = true;
                } else {
                    bindings.insert(alias);
                }
            }
        }
        "use_wildcard" => *conservative = true,
        "scoped_use_list" | "scoped_use_tree" => {
            let mut nested_prefix = prefix.to_vec();
            if let Some(path) = node.field("path") {
                nested_prefix.extend(path_segments(path));
            }
            if let Some(list) = node.field("list") {
                collect_use_bindings(list, &nested_prefix, bindings, conservative);
            } else {
                for child in node.children().filter(|child| child.kind() == "use_list") {
                    collect_use_bindings(child, &nested_prefix, bindings, conservative);
                }
            }
        }
        "use_list" => {
            for child in node.children().filter(|child| child.is_named()) {
                collect_use_bindings(child, prefix, bindings, conservative);
            }
        }
        "scoped_identifier" => {
            if let Some(name) = node.field("name") {
                bindings.insert(name.text().into_owned());
            }
        }
        "identifier" | "type_identifier" => {
            bindings.insert(node.text().into_owned());
        }
        "self" => {
            if let Some(binding) = prefix.last() {
                bindings.insert(binding.clone());
            }
        }
        _ => {
            for child in node.children().filter(|child| child.is_named()) {
                collect_use_bindings(child, prefix, bindings, conservative);
            }
        }
    }
}

fn path_segments<D: ast_grep_core::Doc>(node: Node<D>) -> Vec<String> {
    node.dfs()
        .filter(|child| {
            matches!(
                child.kind().as_ref(),
                "identifier" | "type_identifier" | "self" | "super" | "crate"
            )
        })
        .map(|child| child.text().into_owned())
        .collect()
}

fn type_name_node<D: ast_grep_core::Doc>(node: Node<D>) -> Option<Node<D>> {
    node.dfs()
        .find(|child| child.kind() == "type_identifier")
        .or_else(|| node.dfs().find(|child| child.kind() == "primitive_type"))
        .or_else(|| node.dfs().find(|child| child.kind() == "identifier"))
}

fn attached_start<D: ast_grep_core::Doc>(node: Node<D>, source: &str) -> Option<usize> {
    let mut previous = node.prev();
    let mut next_start = node.range().start;
    let mut start = None;
    let mut has_outer_syntax = false;
    while let Some(attached) = previous {
        let kind = attached.kind();
        let is_comment = matches!(kind.as_ref(), "line_comment" | "block_comment");
        let is_doc = is_comment && is_rust_doc_comment(attached.text().trim_start());
        let attached_range = attached.range();
        let comment_end = if kind == "line_comment" {
            source[attached_range.start..next_start]
                .find('\n')
                .map_or(attached_range.end, |offset| attached_range.start + offset)
        } else {
            attached_range.end
        };
        let gap_newlines = source[comment_end..next_start]
            .bytes()
            .filter(|byte| *byte == b'\n')
            .count();
        if (!is_comment && kind != "attribute_item")
            || (is_comment && gap_newlines > 1)
            || !source[attached.range().end..next_start]
                .lines()
                .all(|line| line.trim().is_empty())
        {
            break;
        }
        start = Some(attached.range().start);
        has_outer_syntax |= is_doc || kind == "attribute_item";
        next_start = attached.range().start;
        previous = attached.prev();
    }
    has_outer_syntax.then_some(start).flatten()
}

fn is_rust_doc_comment(text: &str) -> bool {
    (text.starts_with("///") && !text.starts_with("////"))
        || (text.starts_with("/**") && !text.starts_with("/***"))
}

fn source_without_attached_comments<D: ast_grep_core::Doc>(
    node: Node<D>,
    source: &str,
    start: usize,
    end: usize,
) -> String {
    let mut excluded = Vec::new();
    let mut previous = node.prev();
    while let Some(attached) = previous {
        let range = attached.range();
        if range.start < start {
            break;
        }
        if matches!(attached.kind().as_ref(), "line_comment" | "block_comment")
            && !is_rust_doc_comment(attached.text().trim_start())
            && range.end <= end
        {
            excluded.push(range);
        }
        previous = attached.prev();
    }
    excluded.sort_by_key(|range| range.start);
    let mut rendered = String::new();
    let mut cursor = start;
    for range in excluded {
        rendered.push_str(&source[cursor..range.start]);
        cursor = range.end;
    }
    rendered.push_str(&source[cursor..end]);
    rendered
}

fn without_rust_docs(signature: &str) -> String {
    let mut output = String::new();
    let mut in_block_doc = false;
    for line in signature.split_inclusive('\n') {
        let (content, newline) = line
            .strip_suffix('\n')
            .map_or((line, ""), |content| (content, "\n"));
        let trimmed = content.trim_start();
        if in_block_doc {
            if let Some(end) = trimmed.find("*/") {
                in_block_doc = false;
                let tail = &trimmed[end + 2..];
                if !tail.trim().is_empty() {
                    output.push_str(tail.trim_start());
                    output.push_str(newline);
                }
            }
            continue;
        }
        if trimmed.starts_with("///") && !trimmed.starts_with("////") {
            continue;
        }
        if trimmed.starts_with("/**") && !trimmed.starts_with("/***") {
            if let Some(end) = trimmed.find("*/") {
                let tail = &trimmed[end + 2..];
                if !tail.trim().is_empty() {
                    output.push_str(tail.trim_start());
                    output.push_str(newline);
                }
            } else {
                in_block_doc = true;
            }
            continue;
        }
        output.push_str(content);
        output.push_str(newline);
    }
    output.trim().to_owned()
}

fn has_macro_export<D: ast_grep_core::Doc>(node: Node<D>, source: &str) -> bool {
    let start = attached_start(node.clone(), source).unwrap_or(node.range().start);
    let mut previous = node.prev();
    while let Some(attached) = previous {
        if attached.range().start < start {
            break;
        }
        if attached.kind() == "attribute_item" {
            let compact = attached
                .text()
                .chars()
                .filter(|character| !character.is_whitespace())
                .collect::<String>();
            if compact.starts_with("#[macro_export") {
                return true;
            }
        }
        previous = attached.prev();
    }
    false
}

fn is_public<D: ast_grep_core::Doc>(node: &Node<D>) -> bool {
    node.children()
        .find(|child| child.kind() == "visibility_modifier")
        .is_some_and(|visibility| is_public_modifier(&visibility))
}

fn is_public_modifier<D: ast_grep_core::Doc>(visibility: &Node<D>) -> bool {
    visibility.text().trim() == "pub"
}
