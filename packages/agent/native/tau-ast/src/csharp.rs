use crate::{
    outline::{
        EntryRole, OutlineEntry, OutlineItem, OutlineMember, OutlineRowKind, ParseCertainty,
        SourceRange, SymbolType,
    },
    source::{certainty, certainty_reason, dedent, indent, source_range},
};
use ast_grep_core::Node;
use std::collections::BTreeSet;

pub fn extract_csharp_items<D: ast_grep_core::Doc>(
    root: Node<D>,
    source: &str,
    include_docs: bool,
) -> Vec<OutlineItem> {
    let recovery_ranges = root
        .dfs()
        .filter(|node| node.is_error() || node.is_missing())
        .map(|node| node.range())
        .collect::<Vec<_>>();
    let mut items = Vec::new();
    extract_scope(
        root.children().filter(|node| node.is_named()).collect(),
        source,
        &recovery_ranges,
        "",
        include_docs,
        &mut items,
    );
    items
}

pub fn filter_csharp_items<D: ast_grep_core::Doc>(
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
            let matching_containers = item
                .members
                .iter()
                .filter(|member| {
                    is_container_symbol(member.entry.symbol_type)
                        && (names.contains(member.entry.name.as_str())
                            || names.contains(member.entry.qualified_name.as_str()))
                })
                .map(|member| member.entry.qualified_name.clone())
                .collect::<Vec<_>>();
            item.members.retain(|member| {
                let container_matches = matching_containers.iter().any(|container| {
                    member.entry.qualified_name == *container
                        || member
                            .entry
                            .qualified_name
                            .strip_prefix(container)
                            .is_some_and(|suffix| suffix.starts_with('.'))
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
                if item_matches {
                    selected_ranges.push(item.entry.range.clone());
                } else {
                    selected_ranges
                        .extend(item.members.iter().map(|member| member.entry.range.clone()));
                }
            }
            selected
        }
    });

    let used_names = used_names(root.clone(), &selected_ranges);
    for node in root.dfs().filter(|node| {
        node.kind() == "using_directive" && using_is_used(node.clone(), &used_names)
    }) {
        items.push(structural_item(
            node,
            source,
            OutlineRowKind::Import,
            SymbolType::Module,
        ));
    }
    items.sort_by_key(|item| item.entry.range.start_byte);
}

pub fn finalize_csharp_signatures(items: &mut [OutlineItem]) {
    for item in items {
        if item.row_kind != OutlineRowKind::Declaration || item.entry.body_range.is_none() {
            continue;
        }
        let header = item.entry.signature.trim_end();
        let direct_members = item
            .members
            .iter()
            .filter(|member| {
                member
                    .entry
                    .qualified_name
                    .rsplit_once('.')
                    .is_some_and(|(parent, _)| parent == item.entry.qualified_name)
            })
            .collect::<Vec<_>>();
        item.entry.signature = if direct_members.is_empty() {
            format!("{header}}}")
        } else {
            let members = direct_members
                .iter()
                .enumerate()
                .map(|(index, member)| {
                    let mut signature = member.entry.signature.clone();
                    if member.entry.symbol_type == SymbolType::EnumMember {
                        signature.push(if index + 1 == direct_members.len() {
                            ' '
                        } else {
                            ','
                        });
                        signature = signature.trim_end().to_owned();
                    }
                    indent(&signature)
                })
                .collect::<Vec<_>>()
                .join("\n");
            format!("{header}\n{members}\n}}")
        };
    }
}

pub fn matching_csharp_imports<'a, D: ast_grep_core::Doc>(
    root: Node<D>,
    source: &'a str,
    declaration: &SourceRange,
) -> Vec<&'a str> {
    let used_names = used_names(root.clone(), std::slice::from_ref(declaration));
    root.dfs()
        .filter(|node| node.kind() == "using_directive")
        .filter(|node| using_is_used(node.clone(), &used_names))
        .map(|node| {
            let range = node.range();
            &source[range.start..range.end]
        })
        .collect()
}

fn extract_scope<D: ast_grep_core::Doc>(
    nodes: Vec<Node<D>>,
    source: &str,
    recovery_ranges: &[std::ops::Range<usize>],
    namespace: &str,
    include_docs: bool,
    items: &mut Vec<OutlineItem>,
) {
    let mut current_namespace = namespace.to_owned();
    for node in nodes {
        let kind = node.kind().into_owned();
        match kind.as_str() {
            "comment" => {}
            "using_directive" => items.push(structural_item(
                node,
                source,
                OutlineRowKind::Import,
                SymbolType::Module,
            )),
            "file_scoped_namespace_declaration" => {
                if let Some(name) = node.field("name") {
                    current_namespace = qualify(namespace, name.text().trim());
                }
                items.push(structural_item(
                    node,
                    source,
                    OutlineRowKind::Package,
                    SymbolType::Namespace,
                ));
            }
            "namespace_declaration" => {
                let nested_namespace = node
                    .field("name")
                    .map(|name| qualify(namespace, name.text().trim()))
                    .unwrap_or_else(|| namespace.to_owned());
                items.push(structural_item(
                    node.clone(),
                    source,
                    OutlineRowKind::Package,
                    SymbolType::Namespace,
                ));
                if let Some(body) = node.field("body") {
                    extract_scope(
                        body.children().filter(|child| child.is_named()).collect(),
                        source,
                        recovery_ranges,
                        &nested_namespace,
                        include_docs,
                        items,
                    );
                }
            }
            kind if is_type_declaration(kind) => {
                if let Some(item) = type_item(
                    node,
                    source,
                    recovery_ranges,
                    &current_namespace,
                    include_docs,
                ) {
                    items.push(item);
                }
            }
            "delegate_declaration" => {
                if let Some(item) = delegate_item(
                    node,
                    source,
                    recovery_ranges,
                    &current_namespace,
                    include_docs,
                ) {
                    items.push(item);
                }
            }
            _ => items.push(structural_item(
                node,
                source,
                OutlineRowKind::SideEffect,
                SymbolType::Event,
            )),
        }
    }
}

fn type_item<D: ast_grep_core::Doc>(
    node: Node<D>,
    source: &str,
    recovery_ranges: &[std::ops::Range<usize>],
    namespace: &str,
    include_docs: bool,
) -> Option<OutlineItem> {
    let name_node = node.field("name")?;
    let name = name_node.text().into_owned();
    let qualified_name = qualify(namespace, &name);
    let body = node.field("body");
    let public = has_access(&node, "public");
    let members = body.as_ref().map_or_else(Vec::new, |body| {
        type_members(
            node.clone(),
            body.clone(),
            source,
            recovery_ranges,
            &qualified_name,
            node.kind().as_ref(),
            public,
            include_docs,
        )
    });
    let entry = type_entry(
        node.clone(),
        name_node,
        name,
        qualified_name,
        source,
        recovery_ranges,
        EntryRole::Item,
        type_symbol(node.kind().as_ref()),
        body,
        false,
        include_docs,
    );
    Some(OutlineItem {
        entry,
        row_kind: OutlineRowKind::Declaration,
        is_import: false,
        is_exported: public,
        members,
    })
}

#[allow(clippy::too_many_arguments)]
fn type_members<D: ast_grep_core::Doc>(
    declaration: Node<D>,
    body: Node<D>,
    source: &str,
    recovery_ranges: &[std::ops::Range<usize>],
    parent_name: &str,
    parent_kind: &str,
    ancestors_public: bool,
    include_docs: bool,
) -> Vec<OutlineMember> {
    let mut members = Vec::new();
    if matches!(declaration.kind().as_ref(), "record_declaration" | "struct_declaration")
        && let Some(parameters) = declaration
            .children()
            .find(|child| child.kind() == "parameter_list")
    {
        for parameter in parameters
            .children()
            .filter(|child| child.kind() == "parameter")
        {
            if let Some(name_node) = parameter.field("name") {
                let name = name_node.text().into_owned();
                let bytes = parameter.range();
                let item_certainty = certainty(recovery_ranges, &bytes, &declaration.range());
                members.push(OutlineMember {
                    entry: OutlineEntry {
                        role: EntryRole::Member,
                        symbol_type: SymbolType::Property,
                        name: name.clone(),
                        qualified_name: format!("{parent_name}.{name}"),
                        range: source_range(source.as_bytes(), bytes.clone()),
                        name_range: source_range(source.as_bytes(), name_node.range()),
                        receiver_range: None,
                        body_range: None,
                        signature: dedent(
                            parameter.text().trim(),
                            parameter.start_pos().column(&parameter),
                        ),
                        ast_kind: "record_parameter".to_owned(),
                        certainty: item_certainty,
                        certainty_reason: certainty_reason(item_certainty),
                        locator: None,
                    },
                    is_public: ancestors_public,
                });
            }
        }
    }

    let ownership = body.range();
    for member in body.children().filter(|child| child.is_named()) {
        let kind = member.kind().into_owned();
        match kind.as_str() {
            "comment" => {}
            "field_declaration" | "event_field_declaration" => members.extend(field_members(
                member,
                source,
                recovery_ranges,
                parent_name,
                parent_kind,
                ancestors_public,
                ownership.clone(),
                kind == "event_field_declaration",
                include_docs,
            )),
            "method_declaration"
            | "constructor_declaration"
            | "destructor_declaration"
            | "operator_declaration"
            | "conversion_operator_declaration" => {
                if let Some(callable) = callable_member(
                    member,
                    source,
                    recovery_ranges,
                    parent_name,
                    parent_kind,
                    ancestors_public,
                    ownership.clone(),
                    include_docs,
                ) {
                    members.push(callable);
                }
            }
            "property_declaration" | "indexer_declaration" | "event_declaration" => {
                members.extend(accessor_members(
                    member,
                    source,
                    recovery_ranges,
                    parent_name,
                    parent_kind,
                    ancestors_public,
                    ownership.clone(),
                    include_docs,
                ));
            }
            "enum_member_declaration" => {
                if let Some(enum_member) = enum_member(
                    member,
                    source,
                    recovery_ranges,
                    parent_name,
                    ancestors_public,
                    ownership.clone(),
                    include_docs,
                ) {
                    members.push(enum_member);
                }
            }
            "delegate_declaration" => {
                if let Some(delegate) = delegate_member(
                    member,
                    source,
                    recovery_ranges,
                    parent_name,
                    parent_kind,
                    ancestors_public,
                    ownership.clone(),
                    include_docs,
                ) {
                    members.push(delegate);
                }
            }
            kind if is_type_declaration(kind) => {
                let Some(name_node) = member.field("name") else {
                    continue;
                };
                let name = name_node.text().into_owned();
                let qualified_name = format!("{parent_name}.{name}");
                let directly_public = member_public(&member, parent_kind);
                let effectively_public = ancestors_public && directly_public;
                let nested_body = member.field("body");
                members.push(OutlineMember {
                    entry: type_entry(
                        member.clone(),
                        name_node,
                        name,
                        qualified_name.clone(),
                        source,
                        recovery_ranges,
                        EntryRole::Member,
                        type_symbol(kind),
                        nested_body.clone(),
                        true,
                        include_docs,
                    ),
                    is_public: effectively_public,
                });
                if let Some(nested_body) = nested_body {
                    members.extend(type_members(
                        member,
                        nested_body,
                        source,
                        recovery_ranges,
                        &qualified_name,
                        kind,
                        effectively_public,
                        include_docs,
                    ));
                }
            }
            _ => {}
        }
    }
    members
}

#[allow(clippy::too_many_arguments)]
fn type_entry<D: ast_grep_core::Doc>(
    node: Node<D>,
    name_node: Node<D>,
    name: String,
    qualified_name: String,
    source: &str,
    recovery_ranges: &[std::ops::Range<usize>],
    role: EntryRole,
    symbol_type: SymbolType,
    body: Option<Node<D>>,
    nested: bool,
    include_docs: bool,
) -> OutlineEntry {
    let node_range = node.range();
    let start = attached_doc_start(node.clone(), source).unwrap_or(node_range.start);
    let declaration_range = start..node_range.end;
    let signature_start = if include_docs { start } else { node_range.start };
    let item_certainty = certainty(recovery_ranges, &declaration_range, &node_range);
    let mut signature = body.as_ref().map_or_else(
        || source[signature_start..node_range.end].trim_end().to_owned(),
        |body| source[signature_start..body.range().start + 1].trim_end().to_owned(),
    );
    if nested && body.is_some() {
        signature.push_str(" … }");
    }
    OutlineEntry {
        role,
        symbol_type,
        name,
        qualified_name,
        range: source_range(source.as_bytes(), declaration_range),
        name_range: source_range(source.as_bytes(), name_node.range()),
        receiver_range: None,
        body_range: body.map(|body| source_range(source.as_bytes(), body.range())),
        signature: if role == EntryRole::Member {
            dedent(&signature, node.start_pos().column(&node))
        } else {
            signature
        },
        ast_kind: node.kind().into_owned(),
        certainty: item_certainty,
        certainty_reason: certainty_reason(item_certainty),
        locator: None,
    }
}

#[allow(clippy::too_many_arguments)]
fn field_members<D: ast_grep_core::Doc>(
    declaration: Node<D>,
    source: &str,
    recovery_ranges: &[std::ops::Range<usize>],
    parent_name: &str,
    parent_kind: &str,
    ancestors_public: bool,
    ownership: std::ops::Range<usize>,
    event: bool,
    include_docs: bool,
) -> Vec<OutlineMember> {
    let declaration_range = declaration.range();
    let start = attached_doc_start(declaration.clone(), source)
        .filter(|start| *start >= ownership.start)
        .unwrap_or(declaration_range.start);
    let signature_start = if include_docs { start } else { declaration_range.start };
    let Some(variable) = declaration
        .children()
        .find(|child| child.kind() == "variable_declaration")
    else {
        return Vec::new();
    };
    let Some(type_node) = variable.field("type") else {
        return Vec::new();
    };
    let prefix = source[signature_start..type_node.range().end].trim_end();
    let public = ancestors_public && member_public(&declaration, parent_kind);
    variable
        .children()
        .filter(|child| child.kind() == "variable_declarator")
        .filter_map(|declarator| {
            let name_node = declarator.field("name")?;
            let name = name_node.text().into_owned();
            let value = declarator
                .children()
                .filter(|child| child.is_named())
                .find(|child| child.range().start >= name_node.range().end);
            let declarator_signature = value.as_ref().map_or_else(
                || declarator.text().trim().to_owned(),
                |value| {
                    let before = source[declarator.range().start..value.range().start].trim_end();
                    format!("{before} …")
                },
            );
            let item_certainty =
                certainty(recovery_ranges, &(start..declaration_range.end), &ownership);
            Some(OutlineMember {
                entry: OutlineEntry {
                    role: EntryRole::Member,
                    symbol_type: if event { SymbolType::Event } else { SymbolType::Field },
                    name: name.clone(),
                    qualified_name: format!("{parent_name}.{name}"),
                    range: source_range(source.as_bytes(), start..declaration_range.end),
                    name_range: source_range(source.as_bytes(), name_node.range()),
                    receiver_range: None,
                    body_range: value.map(|value| source_range(source.as_bytes(), value.range())),
                    signature: dedent(
                        &format!("{prefix} {declarator_signature};"),
                        declaration.start_pos().column(&declaration),
                    ),
                    ast_kind: declaration.kind().into_owned(),
                    certainty: item_certainty,
                    certainty_reason: certainty_reason(item_certainty),
                    locator: None,
                },
                is_public: public,
            })
        })
        .collect()
}

#[allow(clippy::too_many_arguments)]
fn callable_member<D: ast_grep_core::Doc>(
    member: Node<D>,
    source: &str,
    recovery_ranges: &[std::ops::Range<usize>],
    parent_name: &str,
    parent_kind: &str,
    ancestors_public: bool,
    ownership: std::ops::Range<usize>,
    include_docs: bool,
) -> Option<OutlineMember> {
    let (name, name_range, symbol_type) = match member.kind().as_ref() {
        "operator_declaration" => {
            let operator = member.field("operator")?;
            (
                format!("operator {}", operator.text().trim()),
                operator.range(),
                SymbolType::Operator,
            )
        }
        "conversion_operator_declaration" => {
            let type_node = member.field("type")?;
            let prefix = source[member.range().start..type_node.range().start].trim();
            let conversion = if prefix.contains("implicit") {
                "implicit operator"
            } else {
                "explicit operator"
            };
            (conversion.to_owned(), type_node.range(), SymbolType::Operator)
        }
        "destructor_declaration" => {
            let name_node = member.field("name")?;
            (
                format!("~{}", name_node.text().trim()),
                name_node.range(),
                SymbolType::Method,
            )
        }
        "constructor_declaration" => {
            let name_node = member.field("name")?;
            (
                name_node.text().into_owned(),
                name_node.range(),
                SymbolType::Constructor,
            )
        }
        _ => {
            let name_node = member.field("name")?;
            (
                name_node.text().into_owned(),
                name_node.range(),
                SymbolType::Method,
            )
        }
    };
    let member_range = member.range();
    let start = attached_doc_start(member.clone(), source)
        .filter(|start| *start >= ownership.start)
        .unwrap_or(member_range.start);
    let signature_start = if include_docs { start } else { member_range.start };
    let body = member.field("body");
    let mut signature = body.as_ref().map_or_else(
        || source[signature_start..member_range.end].trim_end().to_owned(),
        |body| source[signature_start..body.range().start].trim_end().to_owned(),
    );
    if body.as_ref().is_some_and(|body| body.kind() == "arrow_expression_clause") {
        signature.push_str(" => …;");
    }
    let member_certainty = certainty(recovery_ranges, &(start..member_range.end), &ownership);
    Some(OutlineMember {
        entry: OutlineEntry {
            role: EntryRole::Member,
            symbol_type,
            name: name.clone(),
            qualified_name: format!("{parent_name}.{name}"),
            range: source_range(source.as_bytes(), start..member_range.end),
            name_range: source_range(source.as_bytes(), name_range),
            receiver_range: None,
            body_range: body.map(|body| source_range(source.as_bytes(), body.range())),
            signature: dedent(&signature, member.start_pos().column(&member)),
            ast_kind: member.kind().into_owned(),
            certainty: member_certainty,
            certainty_reason: certainty_reason(member_certainty),
            locator: None,
        },
        is_public: ancestors_public && member_public(&member, parent_kind),
    })
}

#[allow(clippy::too_many_arguments)]
fn accessor_members<D: ast_grep_core::Doc>(
    member: Node<D>,
    source: &str,
    recovery_ranges: &[std::ops::Range<usize>],
    parent_name: &str,
    parent_kind: &str,
    ancestors_public: bool,
    ownership: std::ops::Range<usize>,
    include_docs: bool,
) -> Vec<OutlineMember> {
    let member_range = member.range();
    let start = attached_doc_start(member.clone(), source)
        .filter(|start| *start >= ownership.start)
        .unwrap_or(member_range.start);
    let signature_start = if include_docs { start } else { member_range.start };
    let accessors = member.field("accessors");
    let value = member.field("value");
    let (name, name_range, symbol_type) = if member.kind() == "indexer_declaration" {
        let type_end = member.field("type").map_or(member_range.start, |node| node.range().end);
        let parameters_start = member
            .field("parameters")
            .map_or(member_range.end, |node| node.range().start);
        let this_start = source[type_end..parameters_start]
            .find("this")
            .map_or(type_end, |offset| type_end + offset);
        ("this".to_owned(), this_start..this_start + 4, SymbolType::Property)
    } else {
        let name_node = match member.field("name") {
            Some(name) => name,
            None => return Vec::new(),
        };
        (
            name_node.text().into_owned(),
            name_node.range(),
            if member.kind() == "event_declaration" {
                SymbolType::Event
            } else {
                SymbolType::Property
            },
        )
    };
    let public = ancestors_public && member_public(&member, parent_kind);
    let body = accessors.clone().or_else(|| value.clone());
    let mut signature = body.as_ref().map_or_else(
        || source[signature_start..member_range.end].trim_end().to_owned(),
        |body| source[signature_start..body.range().start].trim_end().to_owned(),
    );
    if accessors.is_some() {
        signature.push_str(" { … }");
    } else if value.is_some() {
        signature.push_str("=> …;");
    }
    let member_certainty = certainty(recovery_ranges, &(start..member_range.end), &ownership);
    let mut members = vec![OutlineMember {
        entry: OutlineEntry {
            role: EntryRole::Member,
            symbol_type,
            name: name.clone(),
            qualified_name: format!("{parent_name}.{name}"),
            range: source_range(source.as_bytes(), start..member_range.end),
            name_range: source_range(source.as_bytes(), name_range),
            receiver_range: None,
            body_range: body.map(|body| source_range(source.as_bytes(), body.range())),
            signature: dedent(&signature, member.start_pos().column(&member)),
            ast_kind: member.kind().into_owned(),
            certainty: member_certainty,
            certainty_reason: certainty_reason(member_certainty),
            locator: None,
        },
        is_public: public,
    }];
    if let Some(accessors) = accessors {
        for accessor in accessors
            .children()
            .filter(|child| child.kind() == "accessor_declaration")
        {
            let Some(accessor_name) = accessor.field("name") else {
                continue;
            };
            let accessor_range = accessor.range();
            let accessor_body = accessor.field("body");
            let mut accessor_signature = accessor_body.as_ref().map_or_else(
                || accessor.text().trim().to_owned(),
                |body| source[accessor_range.start..body.range().start].trim_end().to_owned(),
            );
            if accessor_body
                .as_ref()
                .is_some_and(|body| body.kind() == "arrow_expression_clause")
            {
                accessor_signature.push_str(" => …;");
            } else if accessor_body.is_some() {
                accessor_signature.push_str(" { … }");
            } else if !accessor_signature.ends_with(';') {
                accessor_signature.push(';');
            }
            let accessor_certainty = certainty(recovery_ranges, &accessor_range, &ownership);
            let accessor_name_text = accessor_name.text().into_owned();
            members.push(OutlineMember {
                entry: OutlineEntry {
                    role: EntryRole::Member,
                    symbol_type: SymbolType::Property,
                    name: accessor_name_text.clone(),
                    qualified_name: format!("{parent_name}.{name}.{accessor_name_text}"),
                    range: source_range(source.as_bytes(), accessor_range.clone()),
                    name_range: source_range(source.as_bytes(), accessor_name.range()),
                    receiver_range: None,
                    body_range: accessor_body
                        .map(|body| source_range(source.as_bytes(), body.range())),
                    signature: dedent(
                        &accessor_signature,
                        accessor.start_pos().column(&accessor),
                    ),
                    ast_kind: accessor.kind().into_owned(),
                    certainty: accessor_certainty,
                    certainty_reason: certainty_reason(accessor_certainty),
                    locator: None,
                },
                is_public: public && accessor_public(&accessor),
            });
        }
    }
    members
}

fn enum_member<D: ast_grep_core::Doc>(
    member: Node<D>,
    source: &str,
    recovery_ranges: &[std::ops::Range<usize>],
    parent_name: &str,
    ancestors_public: bool,
    ownership: std::ops::Range<usize>,
    include_docs: bool,
) -> Option<OutlineMember> {
    let name_node = member.field("name")?;
    let name = name_node.text().into_owned();
    let member_range = member.range();
    let start = attached_doc_start(member.clone(), source)
        .filter(|start| *start >= ownership.start)
        .unwrap_or(member_range.start);
    let signature_start = if include_docs { start } else { member_range.start };
    let value = member.field("value");
    let signature = value.as_ref().map_or_else(
        || source[signature_start..member_range.end].trim().to_owned(),
        |value| {
            let before = source[signature_start..value.range().start].trim_end();
            format!("{before} …")
        },
    );
    let member_certainty = certainty(recovery_ranges, &(start..member_range.end), &ownership);
    Some(OutlineMember {
        entry: OutlineEntry {
            role: EntryRole::Member,
            symbol_type: SymbolType::EnumMember,
            name: name.clone(),
            qualified_name: format!("{parent_name}.{name}"),
            range: source_range(source.as_bytes(), start..member_range.end),
            name_range: source_range(source.as_bytes(), name_node.range()),
            receiver_range: None,
            body_range: value.map(|value| source_range(source.as_bytes(), value.range())),
            signature: dedent(&signature, member.start_pos().column(&member)),
            ast_kind: member.kind().into_owned(),
            certainty: member_certainty,
            certainty_reason: certainty_reason(member_certainty),
            locator: None,
        },
        is_public: ancestors_public,
    })
}

fn delegate_item<D: ast_grep_core::Doc>(
    node: Node<D>,
    source: &str,
    recovery_ranges: &[std::ops::Range<usize>],
    namespace: &str,
    include_docs: bool,
) -> Option<OutlineItem> {
    let name_node = node.field("name")?;
    let name = name_node.text().into_owned();
    let public = has_access(&node, "public");
    Some(OutlineItem {
        entry: simple_entry(
            node,
            name_node,
            name.clone(),
            qualify(namespace, &name),
            source,
            recovery_ranges,
            EntryRole::Item,
            SymbolType::Function,
            include_docs,
        ),
        row_kind: OutlineRowKind::Declaration,
        is_import: false,
        is_exported: public,
        members: Vec::new(),
    })
}

#[allow(clippy::too_many_arguments)]
fn delegate_member<D: ast_grep_core::Doc>(
    node: Node<D>,
    source: &str,
    recovery_ranges: &[std::ops::Range<usize>],
    parent_name: &str,
    parent_kind: &str,
    ancestors_public: bool,
    ownership: std::ops::Range<usize>,
    include_docs: bool,
) -> Option<OutlineMember> {
    let name_node = node.field("name")?;
    let name = name_node.text().into_owned();
    let entry = simple_entry(
        node.clone(),
        name_node,
        name.clone(),
        format!("{parent_name}.{name}"),
        source,
        recovery_ranges,
        EntryRole::Member,
        SymbolType::Function,
        include_docs,
    );
    Some(OutlineMember {
        is_public: ancestors_public
            && member_public(&node, parent_kind)
            && entry.range.start_byte >= ownership.start,
        entry,
    })
}

#[allow(clippy::too_many_arguments)]
fn simple_entry<D: ast_grep_core::Doc>(
    node: Node<D>,
    name_node: Node<D>,
    name: String,
    qualified_name: String,
    source: &str,
    recovery_ranges: &[std::ops::Range<usize>],
    role: EntryRole,
    symbol_type: SymbolType,
    include_docs: bool,
) -> OutlineEntry {
    let node_range = node.range();
    let start = attached_doc_start(node.clone(), source).unwrap_or(node_range.start);
    let signature_start = if include_docs { start } else { node_range.start };
    let item_certainty = certainty(recovery_ranges, &(start..node_range.end), &node_range);
    OutlineEntry {
        role,
        symbol_type,
        name,
        qualified_name,
        range: source_range(source.as_bytes(), start..node_range.end),
        name_range: source_range(source.as_bytes(), name_node.range()),
        receiver_range: None,
        body_range: None,
        signature: dedent(
            source[signature_start..node_range.end].trim_end(),
            node.start_pos().column(&node),
        ),
        ast_kind: node.kind().into_owned(),
        certainty: item_certainty,
        certainty_reason: certainty_reason(item_certainty),
        locator: None,
    }
}

fn structural_item<D: ast_grep_core::Doc>(
    node: Node<D>,
    source: &str,
    row_kind: OutlineRowKind,
    symbol_type: SymbolType,
) -> OutlineItem {
    let bytes = node.range();
    let range = source_range(source.as_bytes(), bytes.clone());
    let name_node = (row_kind == OutlineRowKind::Package)
        .then(|| node.field("name"))
        .flatten();
    let name = if let Some(name_node) = &name_node {
        name_node.text().into_owned()
    } else if row_kind == OutlineRowKind::Import {
        "using".to_owned()
    } else {
        node.kind().replace('_', " ")
    };
    OutlineItem {
        entry: OutlineEntry {
            role: EntryRole::Item,
            symbol_type,
            name: name.clone(),
            qualified_name: name,
            range: range.clone(),
            name_range: name_node.map_or(range, |name| source_range(source.as_bytes(), name.range())),
            receiver_range: None,
            body_range: None,
            signature: source[bytes].trim().to_owned(),
            ast_kind: node.kind().into_owned(),
            certainty: ParseCertainty::Certain,
            certainty_reason: None,
            locator: None,
        },
        row_kind,
        is_import: row_kind == OutlineRowKind::Import,
        is_exported: false,
        members: Vec::new(),
    }
}

fn used_names<D: ast_grep_core::Doc>(root: Node<D>, ranges: &[SourceRange]) -> BTreeSet<String> {
    root.dfs()
        .filter(|node| node.kind() == "identifier")
        .filter(|node| {
            let bytes = node.range();
            ranges
                .iter()
                .any(|range| bytes.start >= range.start_byte && bytes.end <= range.end_byte)
        })
        .map(|node| node.text().into_owned())
        .collect()
}

fn using_is_used<D: ast_grep_core::Doc>(declaration: Node<D>, used_names: &BTreeSet<String>) -> bool {
    declaration
        .field("name")
        .is_none_or(|alias| used_names.contains(alias.text().trim()))
}

fn attached_doc_start<D: ast_grep_core::Doc>(node: Node<D>, source: &str) -> Option<usize> {
    let mut previous = node.prev()?;
    let mut start = None;
    loop {
        if previous.kind() != "comment"
            || !previous.text().trim_start().starts_with("///")
            || previous.end_pos().line() + 1 < node.start_pos().line()
            || !source[previous.range().end..node.range().start]
                .lines()
                .all(|line| line.trim().is_empty() || line.trim_start().starts_with("///"))
        {
            break;
        }
        start = Some(previous.range().start);
        let Some(earlier) = previous.prev() else {
            break;
        };
        previous = earlier;
    }
    start
}

fn member_public<D: ast_grep_core::Doc>(node: &Node<D>, parent_kind: &str) -> bool {
    if has_access(node, "private") || has_access(node, "protected") || has_access(node, "internal") {
        return false;
    }
    parent_kind == "interface_declaration" || has_access(node, "public")
}

fn accessor_public<D: ast_grep_core::Doc>(node: &Node<D>) -> bool {
    !has_access(node, "private") && !has_access(node, "protected") && !has_access(node, "internal")
}

fn has_access<D: ast_grep_core::Doc>(node: &Node<D>, access: &str) -> bool {
    node.children()
        .filter(|child| child.kind() == "modifier")
        .any(|modifier| modifier.text().trim() == access)
}

fn qualify(parent: &str, name: &str) -> String {
    if parent.is_empty() {
        name.to_owned()
    } else {
        format!("{parent}.{name}")
    }
}

fn is_type_declaration(kind: &str) -> bool {
    matches!(
        kind,
        "class_declaration"
            | "interface_declaration"
            | "struct_declaration"
            | "record_declaration"
            | "enum_declaration"
    )
}

fn type_symbol(kind: &str) -> SymbolType {
    match kind {
        "interface_declaration" => SymbolType::Interface,
        "struct_declaration" | "record_declaration" => SymbolType::Struct,
        "enum_declaration" => SymbolType::Enum,
        _ => SymbolType::Class,
    }
}

fn is_container_symbol(symbol_type: SymbolType) -> bool {
    matches!(
        symbol_type,
        SymbolType::Class
            | SymbolType::Struct
            | SymbolType::Interface
            | SymbolType::Enum
            | SymbolType::Property
            | SymbolType::Event
    )
}
