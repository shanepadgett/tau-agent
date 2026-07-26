use crate::{
    outline::{
        EntryRole, OutlineEntry, OutlineItem, OutlineMember, OutlineRowKind, ParseCertainty,
        SourceRange, SymbolType,
    },
    source::{certainty, certainty_reason, dedent, indent, source_range},
};
use ast_grep_core::Node;
use std::collections::BTreeSet;

pub fn extract_kotlin_items<D: ast_grep_core::Doc>(
    root: Node<D>,
    source: &str,
    include_docs: bool,
) -> Vec<OutlineItem> {
    let recovery_ranges = root
        .dfs()
        .filter(|node| node.is_error() || node.is_missing())
        .map(|node| node.range())
        .collect::<Vec<_>>();
    let nodes = root
        .children()
        .filter(|node| node.is_named())
        .collect::<Vec<_>>();
    let mut items = Vec::new();
    let mut index = 0;
    while index < nodes.len() {
        let node = nodes[index].clone();
        match node.kind().as_ref() {
            "line_comment" | "multiline_comment" => {}
            "package_header" => items.push(package_item(node, source)),
            "import_list" => {
                items.extend(
                    node.children()
                        .filter(|child| child.kind() == "import_header")
                        .map(|import| import_item(import, source)),
                );
            }
            "class_declaration" | "object_declaration" => {
                if let Some(item) = class_item(
                    node,
                    source,
                    &recovery_ranges,
                    include_docs,
                    EntryRole::Item,
                    "",
                    true,
                    false,
                ) {
                    items.push(item);
                }
            }
            "function_declaration" => {
                if let Some(item) = function_item(
                    node,
                    source,
                    &recovery_ranges,
                    include_docs,
                    EntryRole::Item,
                    "",
                    true,
                ) {
                    items.push(item);
                }
            }
            "property_declaration" => {
                let (accessors, consumed) = following_accessors(&nodes, index);
                if let Some(item) = property_item(
                    node,
                    &accessors,
                    source,
                    &recovery_ranges,
                    include_docs,
                    EntryRole::Item,
                    "",
                    true,
                ) {
                    items.push(item);
                }
                index += consumed;
            }
            "type_alias" => {
                if let Some(item) = type_alias_item(
                    node,
                    source,
                    &recovery_ranges,
                    include_docs,
                    EntryRole::Item,
                    "",
                    true,
                ) {
                    items.push(item);
                }
            }
            "ERROR" | "infix_expression" => {
                let split_body = nodes
                    .get(index + 1)
                    .filter(|next| next.kind() == "lambda_literal");
                let recovered = split_body
                    .and_then(|body| {
                        recovered_class_parts(
                            node.clone(),
                            body.clone(),
                            node.range().start..body.range().end,
                            source,
                            &recovery_ranges,
                            include_docs,
                        )
                    })
                    .or_else(|| {
                        recovered_class_item(node.clone(), source, &recovery_ranges, include_docs)
                    });
                if let Some(item) = recovered {
                    items.push(item);
                    if split_body.is_some() {
                        index += 1;
                    }
                } else {
                    items.push(structural_item(
                        node,
                        source,
                        OutlineRowKind::SideEffect,
                        SymbolType::Event,
                    ));
                }
            }
            _ => {
                if let Some(item) =
                    recovered_class_item(node.clone(), source, &recovery_ranges, include_docs)
                {
                    items.push(item);
                } else {
                    items.push(structural_item(
                        node,
                        source,
                        OutlineRowKind::SideEffect,
                        SymbolType::Event,
                    ));
                }
            }
        }
        index += 1;
    }
    items
}

pub fn filter_kotlin_items<D: ast_grep_core::Doc>(
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
                    is_container(member.entry.symbol_type)
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

    let used_names = used_kotlin_names(root.clone(), &selected_ranges);
    for import in root
        .children()
        .find(|node| node.kind() == "import_list")
        .into_iter()
        .flat_map(|list| list.children().collect::<Vec<_>>())
        .filter(|node| {
            node.kind() == "import_header" && kotlin_import_is_used(node.clone(), &used_names)
        })
    {
        items.push(import_item(import, source));
    }
    items.sort_by_key(|item| item.entry.range.start_byte);
}

pub fn finalize_kotlin_signatures(items: &mut [OutlineItem]) {
    for item in items {
        if item.row_kind != OutlineRowKind::Declaration
            || !is_container(item.entry.symbol_type)
            || item.entry.body_range.is_none()
        {
            continue;
        }
        let header = item.entry.signature.trim_end();
        item.entry.signature = if item.members.is_empty() {
            format!("{header}}}")
        } else {
            let members = item
                .members
                .iter()
                .filter(|member| {
                    member
                        .entry
                        .qualified_name
                        .rsplit_once('.')
                        .is_some_and(|(parent, _)| parent == item.entry.qualified_name)
                })
                .map(|member| indent(&member.entry.signature))
                .collect::<Vec<_>>()
                .join("\n");
            if members.is_empty() {
                format!("{header}}}")
            } else {
                format!("{header}\n{members}\n}}")
            }
        };
    }
}

pub fn matching_kotlin_imports<'a, D: ast_grep_core::Doc>(
    root: Node<D>,
    source: &'a str,
    declaration: &SourceRange,
) -> Vec<&'a str> {
    let used_names = used_kotlin_names(root.clone(), std::slice::from_ref(declaration));
    root.children()
        .find(|node| node.kind() == "import_list")
        .into_iter()
        .flat_map(|list| list.children().collect::<Vec<_>>())
        .filter(|node| {
            node.kind() == "import_header" && kotlin_import_is_used(node.clone(), &used_names)
        })
        .map(|node| {
            let bytes = import_range(node);
            &source[bytes]
        })
        .collect()
}

#[allow(clippy::too_many_arguments)]
fn class_item<D: ast_grep_core::Doc>(
    node: Node<D>,
    source: &str,
    recovery_ranges: &[std::ops::Range<usize>],
    include_docs: bool,
    role: EntryRole,
    parent_name: &str,
    ancestors_public: bool,
    nested: bool,
) -> Option<OutlineItem> {
    let name_node = node
        .children()
        .find(|child| child.kind() == "type_identifier")?;
    let name = name_node.text().into_owned();
    let qualified_name = qualify(parent_name, &name);
    let directly_public = is_public(&node);
    let effectively_public = ancestors_public && directly_public;
    let body = node
        .children()
        .find(|child| matches!(child.kind().as_ref(), "class_body" | "enum_class_body"));
    let mut members = constructor_members(
        node.clone(),
        source,
        recovery_ranges,
        &qualified_name,
        effectively_public,
    );
    if let Some(body) = &body {
        members.extend(container_members(
            body.clone(),
            source,
            recovery_ranges,
            include_docs,
            &qualified_name,
            effectively_public,
        ));
    }
    let entry = container_entry(
        node.clone(),
        name_node,
        name,
        qualified_name,
        source,
        recovery_ranges,
        include_docs,
        role,
        class_symbol(node.clone(), source),
        body,
        nested,
    );
    Some(OutlineItem {
        entry,
        row_kind: OutlineRowKind::Declaration,
        is_import: false,
        is_exported: effectively_public,
        members,
    })
}

fn recovered_class_item<D: ast_grep_core::Doc>(
    node: Node<D>,
    source: &str,
    recovery_ranges: &[std::ops::Range<usize>],
    include_docs: bool,
) -> Option<OutlineItem> {
    let body = node
        .dfs()
        .filter(|child| child.kind() == "lambda_literal")
        .filter(|child| recovered_class_name(node.clone(), source, child.range().start).is_some())
        .min_by_key(|child| child.range().start)?;
    let ownership = node.range();
    recovered_class_parts(node, body, ownership, source, recovery_ranges, include_docs)
}

fn recovered_class_parts<D: ast_grep_core::Doc>(
    node: Node<D>,
    body: Node<D>,
    ownership: std::ops::Range<usize>,
    source: &str,
    recovery_ranges: &[std::ops::Range<usize>],
    include_docs: bool,
) -> Option<OutlineItem> {
    let (name, name_bytes, symbol_type) =
        recovered_class_name(node.clone(), source, body.range().start)?;
    let qualified_name = name.clone();
    let public = recovered_header_public(&source[node.range().start..name_bytes.start]);
    let mut members = Vec::new();
    if let Some(constructor_range) =
        recovered_constructor_range(node.clone(), source, name_bytes.end, body.range().start)
    {
        let constructor_certainty = certainty(recovery_ranges, &constructor_range, &node.range());
        let constructor_name_range = token_range(source, constructor_range.clone(), "constructor")
            .unwrap_or_else(|| constructor_range.clone());
        members.push(OutlineMember {
            entry: OutlineEntry {
                role: EntryRole::Member,
                symbol_type: SymbolType::Constructor,
                name: "constructor".to_owned(),
                qualified_name: format!("{qualified_name}.constructor"),
                range: source_range(source.as_bytes(), constructor_range.clone()),
                name_range: source_range(source.as_bytes(), constructor_name_range.clone()),
                receiver_range: None,
                body_range: None,
                signature: dedent(
                    source[constructor_range.clone()].trim(),
                    node.start_pos().column(&node),
                ),
                ast_kind: "primary_constructor".to_owned(),
                certainty: constructor_certainty,
                certainty_reason: certainty_reason(constructor_certainty),
                locator: None,
            },
            is_public: public
                && recovered_header_public(
                    &source[constructor_range.start..constructor_name_range.start],
                ),
        });
    }
    members.extend(container_members(
        body.clone(),
        source,
        recovery_ranges,
        include_docs,
        &qualified_name,
        public,
    ));
    let node_range = ownership.start..body.range().end;
    let start = attached_doc_start(node_range.start, source).unwrap_or(node_range.start);
    let declaration_range = start..node_range.end;
    let item_certainty = certainty(recovery_ranges, &declaration_range, &ownership);
    let signature_start = if include_docs {
        start
    } else {
        node_range.start
    };
    Some(OutlineItem {
        entry: OutlineEntry {
            role: EntryRole::Item,
            symbol_type,
            name,
            qualified_name,
            range: source_range(source.as_bytes(), declaration_range),
            name_range: source_range(source.as_bytes(), name_bytes),
            receiver_range: None,
            body_range: Some(source_range(source.as_bytes(), body.range())),
            signature: container_header(source, signature_start, body.range().start),
            ast_kind: "class_declaration".to_owned(),
            certainty: item_certainty,
            certainty_reason: certainty_reason(item_certainty),
            locator: None,
        },
        row_kind: OutlineRowKind::Declaration,
        is_import: false,
        is_exported: public,
        members,
    })
}

#[allow(clippy::too_many_arguments)]
fn container_entry<D: ast_grep_core::Doc>(
    node: Node<D>,
    name_node: Node<D>,
    name: String,
    qualified_name: String,
    source: &str,
    recovery_ranges: &[std::ops::Range<usize>],
    include_docs: bool,
    role: EntryRole,
    symbol_type: SymbolType,
    body: Option<Node<D>>,
    nested: bool,
) -> OutlineEntry {
    let node_range = node.range();
    let start = attached_doc_start(node_range.start, source).unwrap_or(node_range.start);
    let declaration_range = start..node_range.end;
    let item_certainty = certainty(recovery_ranges, &declaration_range, &node_range);
    let signature_start = if include_docs {
        start
    } else {
        node_range.start
    };
    let signature = body.as_ref().map_or_else(
        || source[signature_start..node_range.end].trim().to_owned(),
        |body| {
            let mut signature = container_header(source, signature_start, body.range().start);
            if nested {
                signature.push_str(" … }");
            }
            signature
        },
    );
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

fn constructor_members<D: ast_grep_core::Doc>(
    class: Node<D>,
    source: &str,
    recovery_ranges: &[std::ops::Range<usize>],
    parent_name: &str,
    parent_public: bool,
) -> Vec<OutlineMember> {
    let Some(constructor) = class
        .children()
        .find(|child| child.kind() == "primary_constructor")
    else {
        return Vec::new();
    };
    let ownership = class.range();
    let constructor_range = constructor.range();
    let constructor_certainty = certainty(recovery_ranges, &constructor_range, &ownership);
    let mut members = vec![OutlineMember {
        entry: OutlineEntry {
            role: EntryRole::Member,
            symbol_type: SymbolType::Constructor,
            name: "constructor".to_owned(),
            qualified_name: format!("{parent_name}.constructor"),
            range: source_range(source.as_bytes(), constructor_range.clone()),
            name_range: constructor
                .children()
                .find(|child| child.kind() == "constructor")
                .map_or_else(
                    || source_range(source.as_bytes(), constructor_range.clone()),
                    |name| source_range(source.as_bytes(), name.range()),
                ),
            receiver_range: None,
            body_range: None,
            signature: {
                let signature = source[constructor_range.clone()].trim();
                let signature = if signature.starts_with('(') {
                    format!("constructor{signature}")
                } else {
                    signature.to_owned()
                };
                dedent(&signature, constructor.start_pos().column(&constructor))
            },
            ast_kind: constructor.kind().into_owned(),
            certainty: constructor_certainty,
            certainty_reason: certainty_reason(constructor_certainty),
            locator: None,
        },
        is_public: parent_public && is_public(&constructor),
    }];
    for parameter in constructor
        .children()
        .filter(|child| child.kind() == "class_parameter")
    {
        let has_property = parameter
            .children()
            .any(|child| child.kind() == "binding_pattern_kind");
        if !has_property {
            continue;
        }
        let Some(name_node) = parameter
            .children()
            .find(|child| child.kind() == "simple_identifier")
        else {
            continue;
        };
        let name = name_node.text().into_owned();
        let parameter_range = parameter.range();
        let value = parameter
            .children()
            .filter(|child| child.is_named() && child.range().start > name_node.range().end)
            .last()
            .filter(|child| source[name_node.range().end..child.range().start].contains('='));
        let signature = value.as_ref().map_or_else(
            || parameter.text().trim().to_owned(),
            |value| {
                format!(
                    "{} …",
                    source[parameter_range.start..value.range().start].trim_end()
                )
            },
        );
        let parameter_certainty = certainty(recovery_ranges, &parameter_range, &ownership);
        members.push(OutlineMember {
            entry: OutlineEntry {
                role: EntryRole::Member,
                symbol_type: SymbolType::Property,
                name: name.clone(),
                qualified_name: format!("{parent_name}.{name}"),
                range: source_range(source.as_bytes(), parameter_range),
                name_range: source_range(source.as_bytes(), name_node.range()),
                receiver_range: None,
                body_range: value.map(|value| source_range(source.as_bytes(), value.range())),
                signature,
                ast_kind: parameter.kind().into_owned(),
                certainty: parameter_certainty,
                certainty_reason: certainty_reason(parameter_certainty),
                locator: None,
            },
            is_public: parent_public && is_public(&parameter),
        });
    }
    members
}

fn container_members<D: ast_grep_core::Doc>(
    body: Node<D>,
    source: &str,
    recovery_ranges: &[std::ops::Range<usize>],
    include_docs: bool,
    parent_name: &str,
    parent_public: bool,
) -> Vec<OutlineMember> {
    let nodes = declaration_children(body.clone());
    let mut members = Vec::new();
    let mut index = 0;
    let mut initializer_index = 0;
    while index < nodes.len() {
        let node = nodes[index].clone();
        match node.kind().as_ref() {
            "line_comment" | "multiline_comment" => {}
            "function_declaration" => {
                if let Some(item) = function_item(
                    node,
                    source,
                    recovery_ranges,
                    include_docs,
                    EntryRole::Member,
                    parent_name,
                    parent_public,
                ) {
                    members.push(OutlineMember {
                        is_public: item.is_exported,
                        entry: item.entry,
                    });
                }
            }
            "property_declaration" => {
                let (accessors, consumed) = following_accessors(&nodes, index);
                if let Some(item) = property_item(
                    node,
                    &accessors,
                    source,
                    recovery_ranges,
                    include_docs,
                    EntryRole::Member,
                    parent_name,
                    parent_public,
                ) {
                    members.push(OutlineMember {
                        is_public: item.is_exported,
                        entry: item.entry,
                    });
                    members.extend(item.members);
                }
                index += consumed;
            }
            "secondary_constructor" => members.push(constructor_member(
                node,
                source,
                recovery_ranges,
                include_docs,
                parent_name,
                parent_public,
                body.range(),
            )),
            "anonymous_initializer" => {
                initializer_index += 1;
                members.push(initializer_member(
                    node,
                    source,
                    recovery_ranges,
                    parent_name,
                    body.range(),
                    initializer_index,
                ));
            }
            "class_declaration" | "object_declaration" => {
                if let Some(item) = class_item(
                    node,
                    source,
                    recovery_ranges,
                    include_docs,
                    EntryRole::Member,
                    parent_name,
                    parent_public,
                    true,
                ) {
                    members.push(OutlineMember {
                        is_public: item.is_exported,
                        entry: item.entry,
                    });
                    members.extend(item.members);
                }
            }
            "companion_object" => {
                if let Some(item) = companion_item(
                    node,
                    source,
                    recovery_ranges,
                    include_docs,
                    parent_name,
                    parent_public,
                ) {
                    members.push(OutlineMember {
                        is_public: item.is_exported,
                        entry: item.entry,
                    });
                    members.extend(item.members);
                }
            }
            "infix_expression" => {
                if let Some(item) = recovered_companion_item(
                    node,
                    source,
                    recovery_ranges,
                    include_docs,
                    parent_name,
                    parent_public,
                ) {
                    members.push(OutlineMember {
                        is_public: item.is_exported,
                        entry: item.entry,
                    });
                    members.extend(item.members);
                }
            }
            "type_alias" => {
                if let Some(item) = type_alias_item(
                    node,
                    source,
                    recovery_ranges,
                    include_docs,
                    EntryRole::Member,
                    parent_name,
                    parent_public,
                ) {
                    members.push(OutlineMember {
                        is_public: item.is_exported,
                        entry: item.entry,
                    });
                }
            }
            "enum_entry" => {
                if let Some((entry, nested)) = enum_member(
                    node,
                    source,
                    recovery_ranges,
                    include_docs,
                    parent_name,
                    parent_public,
                    body.range(),
                ) {
                    members.push(entry);
                    members.extend(nested);
                }
            }
            _ => {}
        }
        index += 1;
    }
    members
}

fn declaration_children<D: ast_grep_core::Doc>(body: Node<D>) -> Vec<Node<D>> {
    if let Some(statements) = body.children().find(|child| child.kind() == "statements") {
        return statements
            .children()
            .filter(|child| child.is_named())
            .collect();
    }
    body.children().filter(|child| child.is_named()).collect()
}

fn following_accessors<'tree, D: ast_grep_core::Doc>(
    nodes: &[Node<'tree, D>],
    index: usize,
) -> (Vec<Node<'tree, D>>, usize) {
    let mut accessors = nodes[index]
        .children()
        .filter(|child| matches!(child.kind().as_ref(), "getter" | "setter"))
        .collect::<Vec<_>>();
    let mut consumed = 0;
    while let Some(node) = nodes.get(index + consumed + 1)
        && matches!(node.kind().as_ref(), "getter" | "setter")
    {
        accessors.push(node.clone());
        consumed += 1;
    }
    (accessors, consumed)
}

#[allow(clippy::too_many_arguments)]
fn function_item<D: ast_grep_core::Doc>(
    node: Node<D>,
    source: &str,
    recovery_ranges: &[std::ops::Range<usize>],
    include_docs: bool,
    role: EntryRole,
    parent_name: &str,
    ancestors_public: bool,
) -> Option<OutlineItem> {
    let name_node = node
        .children()
        .find(|child| child.kind() == "simple_identifier")?;
    let name = name_node.text().into_owned();
    let receiver = node.field("receiver");
    let local_name = if parent_name.is_empty() {
        receiver.as_ref().map_or_else(
            || name.clone(),
            |receiver| format!("{}.{}", receiver.text().trim(), name),
        )
    } else {
        name.clone()
    };
    let qualified_name = qualify(parent_name, &local_name);
    let node_range = node.range();
    let start = attached_doc_start(node_range.start, source).unwrap_or(node_range.start);
    let declaration_range = start..node_range.end;
    let body = node
        .children()
        .find(|child| child.kind() == "function_body");
    let signature_start = if include_docs {
        start
    } else {
        node_range.start
    };
    let signature = callable_signature(
        source,
        signature_start,
        node_range.end,
        body.as_ref(),
        role,
        node.start_pos().column(&node),
    );
    let item_certainty = certainty(recovery_ranges, &declaration_range, &node_range);
    let public = ancestors_public && is_public(&node);
    Some(OutlineItem {
        entry: OutlineEntry {
            role: if receiver.is_some() {
                EntryRole::Member
            } else {
                role
            },
            symbol_type: if role == EntryRole::Item && receiver.is_none() {
                SymbolType::Function
            } else {
                SymbolType::Method
            },
            name,
            qualified_name,
            range: source_range(source.as_bytes(), declaration_range),
            name_range: source_range(source.as_bytes(), name_node.range()),
            receiver_range: receiver
                .map(|receiver| source_range(source.as_bytes(), receiver.range())),
            body_range: body.map(|body| source_range(source.as_bytes(), body.range())),
            signature,
            ast_kind: node.kind().into_owned(),
            certainty: item_certainty,
            certainty_reason: certainty_reason(item_certainty),
            locator: None,
        },
        row_kind: OutlineRowKind::Declaration,
        is_import: false,
        is_exported: public,
        members: Vec::new(),
    })
}

#[allow(clippy::too_many_arguments)]
fn property_item<D: ast_grep_core::Doc>(
    node: Node<D>,
    accessors: &[Node<D>],
    source: &str,
    recovery_ranges: &[std::ops::Range<usize>],
    include_docs: bool,
    role: EntryRole,
    parent_name: &str,
    ancestors_public: bool,
) -> Option<OutlineItem> {
    let variable = node
        .children()
        .find(|child| child.kind() == "variable_declaration")?;
    let name_node = variable
        .children()
        .find(|child| child.kind() == "simple_identifier")?;
    let name = name_node.text().into_owned();
    let receiver = node.field("receiver");
    let local_name = if parent_name.is_empty() {
        receiver.as_ref().map_or_else(
            || name.clone(),
            |receiver| format!("{}.{}", receiver.text().trim(), name),
        )
    } else {
        name.clone()
    };
    let qualified_name = qualify(parent_name, &local_name);
    let node_range = node.range();
    let end = accessors
        .last()
        .map_or(node_range.end, |accessor| accessor.range().end);
    let start = attached_doc_start(node_range.start, source).unwrap_or(node_range.start);
    let declaration_range = start..end;
    let value = property_value(node.clone(), variable.range().end, source);
    let signature_start = if include_docs {
        start
    } else {
        node_range.start
    };
    let mut signature = value.as_ref().map_or_else(
        || source[signature_start..node_range.end].trim().to_owned(),
        |value| {
            format!(
                "{} …",
                source[signature_start..value.range().start].trim_end()
            )
        },
    );
    if role == EntryRole::Member {
        signature = dedent(&signature, node.start_pos().column(&node));
    }
    let ownership = node_range.start..end;
    let item_certainty = certainty(recovery_ranges, &declaration_range, &ownership);
    let public = ancestors_public && is_public(&node);
    let members = accessors
        .iter()
        .map(|accessor| {
            accessor_member(
                accessor.clone(),
                source,
                recovery_ranges,
                &qualified_name,
                public,
                ownership.clone(),
            )
        })
        .collect();
    Some(OutlineItem {
        entry: OutlineEntry {
            role: if receiver.is_some() {
                EntryRole::Member
            } else {
                role
            },
            symbol_type: SymbolType::Property,
            name,
            qualified_name,
            range: source_range(source.as_bytes(), declaration_range),
            name_range: source_range(source.as_bytes(), name_node.range()),
            receiver_range: receiver
                .map(|receiver| source_range(source.as_bytes(), receiver.range())),
            body_range: value.map(|value| source_range(source.as_bytes(), value.range())),
            signature,
            ast_kind: node.kind().into_owned(),
            certainty: item_certainty,
            certainty_reason: certainty_reason(item_certainty),
            locator: None,
        },
        row_kind: OutlineRowKind::Declaration,
        is_import: false,
        is_exported: public,
        members,
    })
}

fn property_value<'tree, D: ast_grep_core::Doc>(
    node: Node<'tree, D>,
    variable_end: usize,
    source: &str,
) -> Option<Node<'tree, D>> {
    node.children()
        .filter(|child| {
            child.is_named()
                && child.range().start >= variable_end
                && !matches!(
                    child.kind().as_ref(),
                    "type_constraints" | "getter" | "setter"
                )
        })
        .find(|child| {
            let between = &source[variable_end..child.range().start];
            between.contains('=') || between.split_whitespace().any(|word| word == "by")
        })
}

fn accessor_member<D: ast_grep_core::Doc>(
    accessor: Node<D>,
    source: &str,
    recovery_ranges: &[std::ops::Range<usize>],
    property_name: &str,
    property_public: bool,
    ownership: std::ops::Range<usize>,
) -> OutlineMember {
    let name = if accessor.kind() == "setter" {
        "set"
    } else {
        "get"
    };
    let range = accessor.range();
    let body = accessor
        .children()
        .find(|child| child.kind() == "function_body");
    let accessor_certainty = certainty(recovery_ranges, &range, &ownership);
    let name_range = accessor
        .children()
        .find(|child| child.kind() == name)
        .map_or_else(
            || source_range(source.as_bytes(), range.clone()),
            |node| source_range(source.as_bytes(), node.range()),
        );
    OutlineMember {
        entry: OutlineEntry {
            role: EntryRole::Member,
            symbol_type: if name == "set" {
                SymbolType::Method
            } else {
                SymbolType::Property
            },
            name: name.to_owned(),
            qualified_name: format!("{property_name}.{name}"),
            range: source_range(source.as_bytes(), range.clone()),
            name_range,
            receiver_range: None,
            body_range: body
                .as_ref()
                .map(|body| source_range(source.as_bytes(), body.range())),
            signature: callable_signature(
                source,
                range.start,
                range.end,
                body.as_ref(),
                EntryRole::Member,
                accessor.start_pos().column(&accessor),
            ),
            ast_kind: accessor.kind().into_owned(),
            certainty: accessor_certainty,
            certainty_reason: certainty_reason(accessor_certainty),
            locator: None,
        },
        is_public: property_public && is_public(&accessor),
    }
}

fn constructor_member<D: ast_grep_core::Doc>(
    node: Node<D>,
    source: &str,
    recovery_ranges: &[std::ops::Range<usize>],
    include_docs: bool,
    parent_name: &str,
    parent_public: bool,
    ownership: std::ops::Range<usize>,
) -> OutlineMember {
    let node_range = node.range();
    let start = attached_doc_start(node_range.start, source)
        .filter(|start| *start >= ownership.start)
        .unwrap_or(node_range.start);
    let declaration_range = start..node_range.end;
    let body_bytes = delimited_body_range(source, node_range.clone());
    let signature_start = if include_docs {
        start
    } else {
        node_range.start
    };
    let signature_end = body_bytes
        .as_ref()
        .map_or(node_range.end, |body| body.start);
    let constructor_certainty = certainty(recovery_ranges, &declaration_range, &ownership);
    OutlineMember {
        entry: OutlineEntry {
            role: EntryRole::Member,
            symbol_type: SymbolType::Constructor,
            name: "constructor".to_owned(),
            qualified_name: format!("{parent_name}.constructor"),
            range: source_range(source.as_bytes(), declaration_range),
            name_range: token_range(source, node_range.clone(), "constructor").map_or_else(
                || source_range(source.as_bytes(), node_range.clone()),
                |range| source_range(source.as_bytes(), range),
            ),
            receiver_range: None,
            body_range: body_bytes.map(|body| source_range(source.as_bytes(), body)),
            signature: dedent(
                source[signature_start..signature_end].trim_end(),
                node.start_pos().column(&node),
            ),
            ast_kind: node.kind().into_owned(),
            certainty: constructor_certainty,
            certainty_reason: certainty_reason(constructor_certainty),
            locator: None,
        },
        is_public: parent_public && is_public(&node),
    }
}

fn initializer_member<D: ast_grep_core::Doc>(
    node: Node<D>,
    source: &str,
    recovery_ranges: &[std::ops::Range<usize>],
    parent_name: &str,
    ownership: std::ops::Range<usize>,
    index: usize,
) -> OutlineMember {
    let range = node.range();
    let body = delimited_body_range(source, range.clone()).unwrap_or_else(|| range.clone());
    let initializer_certainty = certainty(recovery_ranges, &range, &ownership);
    let name = format!("<initializer {index}>");
    OutlineMember {
        entry: OutlineEntry {
            role: EntryRole::Member,
            symbol_type: SymbolType::Event,
            name: name.clone(),
            qualified_name: format!("{parent_name}.{name}"),
            range: source_range(source.as_bytes(), range.clone()),
            name_range: source_range(source.as_bytes(), range),
            receiver_range: None,
            body_range: Some(source_range(source.as_bytes(), body)),
            signature: "init { … }".to_owned(),
            ast_kind: node.kind().into_owned(),
            certainty: initializer_certainty,
            certainty_reason: certainty_reason(initializer_certainty),
            locator: None,
        },
        is_public: false,
    }
}

fn companion_item<D: ast_grep_core::Doc>(
    node: Node<D>,
    source: &str,
    recovery_ranges: &[std::ops::Range<usize>],
    include_docs: bool,
    parent_name: &str,
    parent_public: bool,
) -> Option<OutlineItem> {
    let explicit_name = node
        .children()
        .find(|child| child.kind() == "type_identifier");
    let name = explicit_name
        .as_ref()
        .map_or_else(|| "Companion".to_owned(), |name| name.text().into_owned());
    let qualified_name = qualify(parent_name, &name);
    let body = node.children().find(|child| child.kind() == "class_body")?;
    let public = parent_public && is_public(&node);
    let members = container_members(
        body.clone(),
        source,
        recovery_ranges,
        include_docs,
        &qualified_name,
        public,
    );
    let name_node = explicit_name.unwrap_or_else(|| node.clone());
    Some(OutlineItem {
        entry: container_entry(
            node,
            name_node,
            name,
            qualified_name,
            source,
            recovery_ranges,
            include_docs,
            EntryRole::Member,
            SymbolType::Object,
            Some(body),
            true,
        ),
        row_kind: OutlineRowKind::Declaration,
        is_import: false,
        is_exported: public,
        members,
    })
}

fn recovered_companion_item<D: ast_grep_core::Doc>(
    node: Node<D>,
    source: &str,
    recovery_ranges: &[std::ops::Range<usize>],
    include_docs: bool,
    parent_name: &str,
    parent_public: bool,
) -> Option<OutlineItem> {
    let body = node
        .dfs()
        .filter(|child| child.kind() == "lambda_literal")
        .max_by_key(|child| child.range().end)?;
    let header = &source[node.range().start..body.range().start];
    if !header.contains("companion object") {
        return None;
    }
    let name = "Companion".to_owned();
    let qualified_name = qualify(parent_name, &name);
    let public = parent_public && recovered_header_public(header);
    let members = container_members(
        body.clone(),
        source,
        recovery_ranges,
        include_docs,
        &qualified_name,
        public,
    );
    let range = node.range();
    let companion_certainty = certainty(recovery_ranges, &range, &range);
    Some(OutlineItem {
        entry: OutlineEntry {
            role: EntryRole::Member,
            symbol_type: SymbolType::Object,
            name,
            qualified_name,
            range: source_range(source.as_bytes(), range.clone()),
            name_range: token_range(source, range.clone(), "object").map_or_else(
                || source_range(source.as_bytes(), range.clone()),
                |bytes| source_range(source.as_bytes(), bytes),
            ),
            receiver_range: None,
            body_range: Some(source_range(source.as_bytes(), body.range())),
            signature: format!(
                "{} … }}",
                container_header(source, range.start, body.range().start)
            ),
            ast_kind: "companion_object".to_owned(),
            certainty: companion_certainty,
            certainty_reason: certainty_reason(companion_certainty),
            locator: None,
        },
        row_kind: OutlineRowKind::Declaration,
        is_import: false,
        is_exported: public,
        members,
    })
}

fn enum_member<D: ast_grep_core::Doc>(
    node: Node<D>,
    source: &str,
    recovery_ranges: &[std::ops::Range<usize>],
    include_docs: bool,
    parent_name: &str,
    parent_public: bool,
    ownership: std::ops::Range<usize>,
) -> Option<(OutlineMember, Vec<OutlineMember>)> {
    let name_node = node
        .children()
        .find(|child| child.kind() == "simple_identifier")?;
    let name = name_node.text().into_owned();
    let qualified_name = qualify(parent_name, &name);
    let body = node.children().find(|child| child.kind() == "class_body");
    let range = node.range();
    let start = attached_doc_start(range.start, source)
        .filter(|start| *start >= ownership.start)
        .unwrap_or(range.start);
    let declaration_range = start..range.end;
    let signature_start = if include_docs { start } else { range.start };
    let mut signature = body.as_ref().map_or_else(
        || source[signature_start..range.end].trim().to_owned(),
        |body| {
            format!(
                "{} … }}",
                container_header(source, signature_start, body.range().start)
            )
        },
    );
    signature = dedent(&signature, node.start_pos().column(&node));
    let enum_certainty = certainty(recovery_ranges, &declaration_range, &ownership);
    let nested = body.as_ref().map_or_else(Vec::new, |body| {
        container_members(
            body.clone(),
            source,
            recovery_ranges,
            include_docs,
            &qualified_name,
            parent_public,
        )
    });
    Some((
        OutlineMember {
            entry: OutlineEntry {
                role: EntryRole::Member,
                symbol_type: SymbolType::EnumMember,
                name,
                qualified_name,
                range: source_range(source.as_bytes(), declaration_range),
                name_range: source_range(source.as_bytes(), name_node.range()),
                receiver_range: None,
                body_range: body.map(|body| source_range(source.as_bytes(), body.range())),
                signature,
                ast_kind: node.kind().into_owned(),
                certainty: enum_certainty,
                certainty_reason: certainty_reason(enum_certainty),
                locator: None,
            },
            is_public: parent_public,
        },
        nested,
    ))
}

#[allow(clippy::too_many_arguments)]
fn type_alias_item<D: ast_grep_core::Doc>(
    node: Node<D>,
    source: &str,
    recovery_ranges: &[std::ops::Range<usize>],
    include_docs: bool,
    role: EntryRole,
    parent_name: &str,
    ancestors_public: bool,
) -> Option<OutlineItem> {
    let name_node = node
        .children()
        .find(|child| child.kind() == "type_identifier")?;
    let name = name_node.text().into_owned();
    let qualified_name = qualify(parent_name, &name);
    let range = node.range();
    let start = attached_doc_start(range.start, source).unwrap_or(range.start);
    let declaration_range = start..range.end;
    let alias_certainty = certainty(recovery_ranges, &declaration_range, &range);
    let signature_start = if include_docs { start } else { range.start };
    let mut signature = source[signature_start..range.end].trim().to_owned();
    if role == EntryRole::Member {
        signature = dedent(&signature, node.start_pos().column(&node));
    }
    let public = ancestors_public && is_public(&node);
    Some(OutlineItem {
        entry: OutlineEntry {
            role,
            symbol_type: SymbolType::Struct,
            name,
            qualified_name,
            range: source_range(source.as_bytes(), declaration_range),
            name_range: source_range(source.as_bytes(), name_node.range()),
            receiver_range: None,
            body_range: None,
            signature,
            ast_kind: node.kind().into_owned(),
            certainty: alias_certainty,
            certainty_reason: certainty_reason(alias_certainty),
            locator: None,
        },
        row_kind: OutlineRowKind::Declaration,
        is_import: false,
        is_exported: public,
        members: Vec::new(),
    })
}

fn callable_signature<D: ast_grep_core::Doc>(
    source: &str,
    start: usize,
    end: usize,
    body: Option<&Node<D>>,
    role: EntryRole,
    column: usize,
) -> String {
    let signature = body.map_or_else(
        || source[start..end].trim_end().to_owned(),
        |body| {
            let prefix = source[start..body.range().start].trim_end();
            if source[body.range().clone()].trim_start().starts_with('=') {
                format!("{prefix} = …")
            } else {
                prefix.to_owned()
            }
        },
    );
    if role == EntryRole::Member {
        dedent(&signature, column)
    } else {
        signature
    }
}

fn container_header(source: &str, start: usize, body_start: usize) -> String {
    let raw = &source[start..body_start];
    let header = raw.trim_end();
    if raw[header.len()..].contains('\n') {
        format!("{header}\n{{")
    } else {
        format!("{header} {{")
    }
}

fn package_item<D: ast_grep_core::Doc>(node: Node<D>, source: &str) -> OutlineItem {
    let name_node = node
        .children()
        .find(|child| child.kind() == "identifier")
        .unwrap_or_else(|| node.clone());
    let bytes = node.range().start..name_node.range().end;
    let range = source_range(source.as_bytes(), bytes.clone());
    let name = name_node.text().into_owned();
    OutlineItem {
        entry: OutlineEntry {
            role: EntryRole::Item,
            symbol_type: SymbolType::Package,
            name: name.clone(),
            qualified_name: name,
            range: range.clone(),
            name_range: source_range(source.as_bytes(), name_node.range()),
            receiver_range: None,
            body_range: None,
            signature: source[bytes].trim().to_owned(),
            ast_kind: node.kind().into_owned(),
            certainty: ParseCertainty::Certain,
            certainty_reason: None,
            locator: None,
        },
        row_kind: OutlineRowKind::Package,
        is_import: false,
        is_exported: false,
        members: Vec::new(),
    }
}

fn import_item<D: ast_grep_core::Doc>(node: Node<D>, source: &str) -> OutlineItem {
    let bytes = import_range(node.clone());
    let range = source_range(source.as_bytes(), bytes.clone());
    OutlineItem {
        entry: OutlineEntry {
            role: EntryRole::Item,
            symbol_type: SymbolType::Module,
            name: "import".to_owned(),
            qualified_name: "import".to_owned(),
            range: range.clone(),
            name_range: range,
            receiver_range: None,
            body_range: None,
            signature: source[bytes].trim().to_owned(),
            ast_kind: node.kind().into_owned(),
            certainty: ParseCertainty::Certain,
            certainty_reason: None,
            locator: None,
        },
        row_kind: OutlineRowKind::Import,
        is_import: true,
        is_exported: false,
        members: Vec::new(),
    }
}

fn import_range<D: ast_grep_core::Doc>(node: Node<D>) -> std::ops::Range<usize> {
    let end = node
        .children()
        .filter(|child| {
            matches!(
                child.kind().as_ref(),
                "identifier" | "import_alias" | "wildcard_import"
            )
        })
        .map(|child| child.range().end)
        .max()
        .unwrap_or_else(|| node.range().end);
    node.range().start..end
}

fn structural_item<D: ast_grep_core::Doc>(
    node: Node<D>,
    source: &str,
    row_kind: OutlineRowKind,
    symbol_type: SymbolType,
) -> OutlineItem {
    let bytes = node.range();
    let range = source_range(source.as_bytes(), bytes.clone());
    let name = node.kind().replace('_', " ");
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
            signature: source[bytes].trim().to_owned(),
            ast_kind: node.kind().into_owned(),
            certainty: if node.is_error() {
                ParseCertainty::Recovered
            } else {
                ParseCertainty::Certain
            },
            certainty_reason: node
                .is_error()
                .then(|| "parser recovery intersects the top-level structure".to_owned()),
            locator: None,
        },
        row_kind,
        is_import: false,
        is_exported: false,
        members: Vec::new(),
    }
}

fn used_kotlin_names<D: ast_grep_core::Doc>(
    root: Node<D>,
    ranges: &[SourceRange],
) -> BTreeSet<String> {
    root.dfs()
        .filter(|node| {
            matches!(
                node.kind().as_ref(),
                "simple_identifier" | "type_identifier"
            )
        })
        .filter(|node| {
            let bytes = node.range();
            ranges
                .iter()
                .any(|range| bytes.start >= range.start_byte && bytes.end <= range.end_byte)
        })
        .map(|node| node.text().trim_matches('`').to_owned())
        .collect()
}

fn kotlin_import_is_used<D: ast_grep_core::Doc>(
    declaration: Node<D>,
    used_names: &BTreeSet<String>,
) -> bool {
    if declaration
        .children()
        .any(|child| child.kind() == "wildcard_import")
    {
        return true;
    }
    let binding = declaration
        .children()
        .find(|child| child.kind() == "import_alias")
        .and_then(|alias| {
            alias
                .children()
                .find(|child| child.kind() == "type_identifier")
        })
        .or_else(|| {
            declaration
                .children()
                .find(|child| child.kind() == "identifier")
                .and_then(|identifier| {
                    identifier
                        .children()
                        .filter(|child| child.kind() == "simple_identifier")
                        .last()
                })
        });
    binding.is_some_and(|binding| used_names.contains(binding.text().trim_matches('`')))
}

fn class_symbol<D: ast_grep_core::Doc>(node: Node<D>, source: &str) -> SymbolType {
    let header_end = node
        .children()
        .find(|child| matches!(child.kind().as_ref(), "class_body" | "enum_class_body"))
        .map_or(node.range().end, |body| body.range().start);
    let header = &source[node.range().start..header_end];
    if header.split_whitespace().any(|word| word == "interface") {
        SymbolType::Interface
    } else if header.contains("enum class") {
        SymbolType::Enum
    } else if node.kind() == "object_declaration" {
        SymbolType::Object
    } else {
        SymbolType::Class
    }
}

fn is_public<D: ast_grep_core::Doc>(node: &Node<D>) -> bool {
    !node
        .children()
        .find(|child| child.kind() == "modifiers")
        .is_some_and(|modifiers| {
            modifiers.children().any(|modifier| {
                modifier.kind() == "visibility_modifier"
                    && matches!(modifier.text().trim(), "private" | "internal" | "protected")
            })
        })
}

fn recovered_header_public(header: &str) -> bool {
    !header
        .split_whitespace()
        .any(|word| matches!(word, "private" | "internal" | "protected"))
}

fn attached_doc_start(node_start: usize, source: &str) -> Option<usize> {
    let before = &source[..node_start];
    let comment_end = before.rfind("*/")? + 2;
    let between = &before[comment_end..];
    if !between.trim().is_empty() || between.bytes().filter(|byte| *byte == b'\n').count() > 1 {
        return None;
    }
    let start = before[..comment_end].rfind("/*")?;
    before[start..comment_end]
        .starts_with("/**")
        .then_some(start)
}

fn delimited_body_range(
    source: &str,
    range: std::ops::Range<usize>,
) -> Option<std::ops::Range<usize>> {
    let bytes = source.as_bytes();
    let mut index = range.start;
    let mut start = None;
    let mut depth = 0;
    let mut quote = None;
    let mut line_comment = false;
    let mut block_comment = false;
    while index < range.end {
        let byte = bytes[index];
        let next = bytes.get(index + 1).copied();
        if line_comment {
            line_comment = byte != b'\n';
        } else if block_comment {
            if byte == b'*' && next == Some(b'/') {
                block_comment = false;
                index += 1;
            }
        } else if let Some(delimiter) = quote {
            if byte == b'\\' {
                index += 1;
            } else if byte == delimiter {
                quote = None;
            }
        } else if byte == b'/' && next == Some(b'/') {
            line_comment = true;
            index += 1;
        } else if byte == b'/' && next == Some(b'*') {
            block_comment = true;
            index += 1;
        } else if matches!(byte, b'\'' | b'"') {
            quote = Some(byte);
        } else if byte == b'{' {
            start.get_or_insert(index);
            depth += 1;
        } else if byte == b'}' && start.is_some() {
            depth -= 1;
            if depth == 0 {
                return start.map(|start| start..index + 1);
            }
        }
        index += 1;
    }
    None
}

fn token_range(
    source: &str,
    range: std::ops::Range<usize>,
    token: &str,
) -> Option<std::ops::Range<usize>> {
    let offset = source[range.clone()].find(token)?;
    Some(range.start + offset..range.start + offset + token.len())
}

fn recovered_class_name<D: ast_grep_core::Doc>(
    node: Node<D>,
    source: &str,
    header_end: usize,
) -> Option<(String, std::ops::Range<usize>, SymbolType)> {
    let keyword_node = node
        .dfs()
        .filter(|child| child.range().start < header_end)
        .filter(|child| matches!(child.text().trim(), "class" | "interface" | "object"))
        .min_by_key(|child| child.range().start)?;
    let keyword = keyword_node.text();
    let before_keyword = &source[node.range().start..keyword_node.range().start];
    let symbol_type = match keyword.trim() {
        "interface" => SymbolType::Interface,
        "object" => SymbolType::Object,
        "class" if before_keyword.split_whitespace().last() == Some("enum") => SymbolType::Enum,
        "class" => SymbolType::Class,
        _ => return None,
    };
    let after_keyword = &source[keyword_node.range().end..header_end];
    let name_start = keyword_node.range().end
        + after_keyword
            .len()
            .saturating_sub(after_keyword.trim_start().len());
    let tail = &source[name_start..header_end];
    let name_len = if let Some(unquoted) = tail.strip_prefix('`') {
        unquoted.find('`')? + 2
    } else {
        tail.char_indices()
            .find(|(_, character)| {
                character.is_whitespace() || matches!(character, '<' | '(' | ':' | '{' | '/')
            })
            .map_or(tail.len(), |(index, _)| index)
    };
    let name_range = name_start..name_start + name_len;
    Some((
        source[name_range.clone()].trim_matches('`').to_owned(),
        name_range,
        symbol_type,
    ))
}

fn recovered_constructor_range<D: ast_grep_core::Doc>(
    node: Node<D>,
    source: &str,
    start: usize,
    end: usize,
) -> Option<std::ops::Range<usize>> {
    let constructor = node
        .dfs()
        .filter(|child| child.range().start >= start && child.range().end <= end)
        .find(|child| child.text().trim() == "constructor")?
        .range()
        .start;
    let line_start = source[..constructor]
        .rfind('\n')
        .map_or(start, |newline| newline + 1)
        .max(start);
    let declaration_start = line_start
        + source[line_start..constructor]
            .len()
            .saturating_sub(source[line_start..constructor].trim_start().len());
    let open = source[constructor..end]
        .find('(')
        .map(|offset| constructor + offset)?;
    let mut depth = 0;
    for (offset, character) in source[open..end].char_indices() {
        match character {
            '(' => depth += 1,
            ')' => {
                depth -= 1;
                if depth == 0 {
                    return Some(declaration_start..open + offset + 1);
                }
            }
            _ => {}
        }
    }
    None
}

fn qualify(parent: &str, name: &str) -> String {
    if parent.is_empty() {
        name.to_owned()
    } else {
        format!("{parent}.{name}")
    }
}

fn is_container(symbol_type: SymbolType) -> bool {
    matches!(
        symbol_type,
        SymbolType::Class
            | SymbolType::Interface
            | SymbolType::Enum
            | SymbolType::Object
            | SymbolType::Struct
    )
}
