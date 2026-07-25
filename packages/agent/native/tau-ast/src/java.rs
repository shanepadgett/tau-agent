use crate::{
    outline::{
        EntryRole, OutlineEntry, OutlineItem, OutlineMember, OutlineRowKind, ParseCertainty,
        SourceRange, SymbolType,
    },
    source::{certainty, certainty_reason, dedent, indent, source_range},
};
use ast_grep_core::Node;
use std::collections::BTreeSet;

pub fn extract_java_items<D: ast_grep_core::Doc>(
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
    for node in root.children().filter(|node| node.is_named()) {
        match node.kind().as_ref() {
            "line_comment" | "block_comment" => {}
            "package_declaration" => items.push(structural_item(
                node,
                source,
                OutlineRowKind::Package,
                SymbolType::Package,
            )),
            "import_declaration" => items.push(structural_item(
                node,
                source,
                OutlineRowKind::Import,
                SymbolType::Module,
            )),
            kind if is_type_declaration(kind) => {
                if let Some(item) = type_item(node, source, &recovery_ranges, include_docs) {
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
    items
}

pub fn filter_java_items<D: ast_grep_core::Doc>(
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

    let used_names = used_java_names(root.clone(), &selected_ranges);
    for node in root.children().filter(|node| {
        node.kind() == "import_declaration" && java_import_is_used(node.clone(), &used_names)
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

pub fn finalize_java_signatures(items: &mut [OutlineItem]) {
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
            let last_enum_constant = direct_members
                .iter()
                .rposition(|member| member.entry.symbol_type == SymbolType::EnumMember);
            let has_enum_declarations =
                last_enum_constant.is_some_and(|index| index + 1 < direct_members.len());
            let mut members = direct_members
                .iter()
                .enumerate()
                .map(|(index, member)| {
                    let mut signature = member.entry.signature.clone();
                    if is_container_symbol(member.entry.symbol_type) && signature.ends_with('{') {
                        signature.push_str(" … }");
                    }
                    if member.entry.symbol_type == SymbolType::EnumMember {
                        signature.push(if Some(index) == last_enum_constant {
                            if has_enum_declarations { ';' } else { ' ' }
                        } else {
                            ','
                        });
                        signature = signature.trim_end().to_owned();
                    }
                    indent(&signature)
                })
                .collect::<Vec<_>>()
                .join("\n");
            if item.entry.symbol_type == SymbolType::Enum && last_enum_constant.is_none() {
                members = format!("{}\n{members}", indent(";"));
            }
            format!("{header}\n{members}\n}}")
        };
    }
}

pub fn matching_java_imports<'a, D: ast_grep_core::Doc>(
    root: Node<D>,
    source: &'a str,
    declaration: &SourceRange,
) -> Vec<&'a str> {
    let used_names = used_java_names(root.clone(), std::slice::from_ref(declaration));
    root.children()
        .filter(|node| node.kind() == "import_declaration")
        .filter(|node| java_import_is_used(node.clone(), &used_names))
        .map(|node| {
            let range = node.range();
            &source[range.start..range.end]
        })
        .collect()
}

fn type_item<D: ast_grep_core::Doc>(
    node: Node<D>,
    source: &str,
    recovery_ranges: &[std::ops::Range<usize>],
    include_docs: bool,
) -> Option<OutlineItem> {
    let name_node = node.field("name")?;
    let name = name_node.text().into_owned();
    let body = node.field("body")?;
    let public = has_access(&node, "public");
    let members = type_members(
        node.clone(),
        body.clone(),
        source,
        recovery_ranges,
        &name,
        node.kind().as_ref(),
        true,
        include_docs,
    );
    let entry = type_entry(
        node.clone(),
        name_node,
        name.clone(),
        name,
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
    if declaration.kind() == "record_declaration"
        && let Some(parameters) = declaration.field("parameters")
    {
        for component in parameters.children().filter(|child| {
            matches!(
                child.kind().as_ref(),
                "formal_parameter" | "spread_parameter"
            )
        }) {
            if let Some(name_node) = component.field("name").or_else(|| {
                component
                    .children()
                    .find(|child| child.kind() == "variable_declarator")
                    .and_then(|declarator| declarator.field("name"))
            }) {
                let name = name_node.text().into_owned();
                let component_range = component.range();
                let component_certainty =
                    certainty(recovery_ranges, &component_range, &declaration.range());
                members.push(OutlineMember {
                    entry: OutlineEntry {
                        role: EntryRole::Member,
                        symbol_type: SymbolType::Property,
                        name: name.clone(),
                        qualified_name: format!("{parent_name}.{name}"),
                        range: source_range(source.as_bytes(), component_range.clone()),
                        name_range: source_range(source.as_bytes(), name_node.range()),
                        receiver_range: None,
                        body_range: None,
                        signature: dedent(
                            component.text().trim(),
                            component.start_pos().column(&component),
                        ),
                        ast_kind: "record_component".to_owned(),
                        certainty: component_certainty,
                        certainty_reason: certainty_reason(component_certainty),
                        locator: None,
                    },
                    is_public: ancestors_public,
                });
            }
        }
    }

    let ownership = body.range();
    let mut declarations = Vec::new();
    for child in body.children().filter(|child| child.is_named()) {
        if child.kind() == "enum_body_declarations" {
            declarations.extend(child.children().filter(|nested| nested.is_named()));
        } else {
            declarations.push(child);
        }
    }
    let mut static_initializers = 0;
    let mut instance_initializers = 0;
    for member in declarations {
        let member_kind = member.kind().into_owned();
        match member_kind.as_str() {
            "line_comment" | "block_comment" => {}
            "field_declaration" => members.extend(field_members(
                member,
                source,
                recovery_ranges,
                parent_name,
                parent_kind,
                ancestors_public,
                ownership.clone(),
                false,
                include_docs,
            )),
            "constant_declaration" => members.extend(field_members(
                member,
                source,
                recovery_ranges,
                parent_name,
                parent_kind,
                ancestors_public,
                ownership.clone(),
                true,
                include_docs,
            )),
            "method_declaration"
            | "constructor_declaration"
            | "compact_constructor_declaration"
            | "annotation_type_element_declaration" => {
                if let Some(member) = callable_member(
                    member,
                    source,
                    recovery_ranges,
                    parent_name,
                    parent_kind,
                    ancestors_public,
                    ownership.clone(),
                    include_docs,
                ) {
                    members.push(member);
                }
            }
            "enum_constant" => {
                if let Some(member) = enum_constant_member(
                    member,
                    source,
                    recovery_ranges,
                    parent_name,
                    ancestors_public,
                    ownership.clone(),
                    include_docs,
                ) {
                    members.push(member);
                }
            }
            "static_initializer" => {
                static_initializers += 1;
                members.push(initializer_member(
                    member,
                    source,
                    recovery_ranges,
                    parent_name,
                    ownership.clone(),
                    true,
                    static_initializers,
                ));
            }
            "block" => {
                instance_initializers += 1;
                members.push(initializer_member(
                    member,
                    source,
                    recovery_ranges,
                    parent_name,
                    ownership.clone(),
                    false,
                    instance_initializers,
                ));
            }
            kind if is_type_declaration(kind) => {
                let Some(name_node) = member.field("name") else {
                    continue;
                };
                let Some(nested_body) = member.field("body") else {
                    continue;
                };
                let name = name_node.text().into_owned();
                let qualified_name = format!("{parent_name}.{name}");
                let directly_public = member_public(&member, parent_kind);
                let effectively_public = ancestors_public && directly_public;
                let nested_entry = type_entry(
                    member.clone(),
                    name_node,
                    name,
                    qualified_name.clone(),
                    source,
                    recovery_ranges,
                    EntryRole::Member,
                    type_symbol(&member_kind),
                    nested_body.clone(),
                    true,
                    include_docs,
                );
                members.push(OutlineMember {
                    entry: nested_entry,
                    is_public: effectively_public,
                });
                members.extend(type_members(
                    member,
                    nested_body,
                    source,
                    recovery_ranges,
                    &qualified_name,
                    &member_kind,
                    effectively_public,
                    include_docs,
                ));
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
    body: Node<D>,
    nested: bool,
    include_docs: bool,
) -> OutlineEntry {
    let node_range = node.range();
    let start = attached_doc_start(node.clone(), source).unwrap_or(node_range.start);
    let declaration_range = start..node_range.end;
    let signature_start = if include_docs {
        start
    } else {
        node_range.start
    };
    let item_certainty = certainty(recovery_ranges, &declaration_range, &node_range);
    let mut signature = source[signature_start..body.range().start + 1]
        .trim_end()
        .to_owned();
    if nested {
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
        body_range: Some(source_range(source.as_bytes(), body.range())),
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
    constant: bool,
    include_docs: bool,
) -> Vec<OutlineMember> {
    let declaration_range = declaration.range();
    let start = attached_doc_start(declaration.clone(), source)
        .filter(|start| *start >= ownership.start)
        .unwrap_or(declaration_range.start);
    let signature_start = if include_docs {
        start
    } else {
        declaration_range.start
    };
    let Some(type_node) = declaration.field("type") else {
        return Vec::new();
    };
    let prefix = source[signature_start..type_node.range().end].trim_end();
    let public = ancestors_public && member_public(&declaration, parent_kind);
    declaration
        .children()
        .filter(|child| child.kind() == "variable_declarator")
        .filter_map(|declarator| {
            let name_node = declarator.field("name")?;
            let name = name_node.text().into_owned();
            let value = declarator.field("value");
            let declarator_signature = value.as_ref().map_or_else(
                || declarator.text().trim().to_owned(),
                |value| {
                    let before = source[declarator.range().start..value.range().start].trim_end();
                    if before.ends_with('=') {
                        format!("{before} …")
                    } else {
                        format!("{before} = …")
                    }
                },
            );
            let item_certainty =
                certainty(recovery_ranges, &(start..declaration_range.end), &ownership);
            Some(OutlineMember {
                entry: OutlineEntry {
                    role: EntryRole::Member,
                    symbol_type: if constant {
                        SymbolType::Constant
                    } else {
                        SymbolType::Field
                    },
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
    let name_node = member.field("name")?;
    let name = name_node.text().into_owned();
    let member_range = member.range();
    let start = attached_doc_start(member.clone(), source)
        .filter(|start| *start >= ownership.start)
        .unwrap_or(member_range.start);
    let signature_start = if include_docs {
        start
    } else {
        member_range.start
    };
    let body = member.field("body");
    let signature_end = body
        .as_ref()
        .map_or(member_range.end, |body| body.range().start);
    let member_certainty = certainty(recovery_ranges, &(start..member_range.end), &ownership);
    let symbol_type = match member.kind().as_ref() {
        "constructor_declaration" | "compact_constructor_declaration" => SymbolType::Constructor,
        "annotation_type_element_declaration" => SymbolType::Property,
        _ => SymbolType::Method,
    };
    Some(OutlineMember {
        entry: OutlineEntry {
            role: EntryRole::Member,
            symbol_type,
            name: name.clone(),
            qualified_name: format!("{parent_name}.{name}"),
            range: source_range(source.as_bytes(), start..member_range.end),
            name_range: source_range(source.as_bytes(), name_node.range()),
            receiver_range: None,
            body_range: body.map(|body| source_range(source.as_bytes(), body.range())),
            signature: dedent(
                source[signature_start..signature_end].trim_end(),
                member.start_pos().column(&member),
            ),
            ast_kind: member.kind().into_owned(),
            certainty: member_certainty,
            certainty_reason: certainty_reason(member_certainty),
            locator: None,
        },
        is_public: ancestors_public && member_public(&member, parent_kind),
    })
}

fn enum_constant_member<D: ast_grep_core::Doc>(
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
    let signature_start = if include_docs {
        start
    } else {
        member_range.start
    };
    let body = member.field("body");
    let signature_end = body
        .as_ref()
        .map_or(member_range.end, |body| body.range().start);
    let mut body_ranges = member
        .field("arguments")
        .map_or_else(Vec::new, |arguments| {
            arguments
                .dfs()
                .filter_map(|node| match node.kind().as_ref() {
                    "lambda_expression" => node.field("body").map(|body| {
                        let block = body.kind() == "block";
                        (body.range(), block)
                    }),
                    "block" | "class_body" => Some((node.range(), true)),
                    _ => None,
                })
                .collect::<Vec<_>>()
        });
    body_ranges.sort_by_key(|(range, _)| (range.start, std::cmp::Reverse(range.end)));
    let mut outer_ranges = Vec::<(std::ops::Range<usize>, bool)>::new();
    for (range, block) in body_ranges {
        if !outer_ranges
            .iter()
            .any(|(outer, _)| range.start >= outer.start && range.end <= outer.end)
        {
            outer_ranges.push((range, block));
        }
    }
    let mut signature = String::new();
    let mut cursor = signature_start;
    for (range, block) in outer_ranges {
        signature.push_str(&source[cursor..range.start]);
        signature.push_str(if block { "{ … }" } else { "…" });
        cursor = range.end;
    }
    signature.push_str(&source[cursor..signature_end]);
    if body.is_some() {
        signature.push_str("{ … }");
    }
    let signature = signature.trim().to_owned();
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
            body_range: body.map(|body| source_range(source.as_bytes(), body.range())),
            signature: dedent(&signature, member.start_pos().column(&member)),
            ast_kind: member.kind().into_owned(),
            certainty: member_certainty,
            certainty_reason: certainty_reason(member_certainty),
            locator: None,
        },
        is_public: ancestors_public,
    })
}

#[allow(clippy::too_many_arguments)]
fn initializer_member<D: ast_grep_core::Doc>(
    member: Node<D>,
    source: &str,
    recovery_ranges: &[std::ops::Range<usize>],
    parent_name: &str,
    ownership: std::ops::Range<usize>,
    is_static: bool,
    index: usize,
) -> OutlineMember {
    let body = if is_static {
        member
            .children()
            .find(|child| child.kind() == "block")
            .unwrap_or_else(|| member.clone())
    } else {
        member.clone()
    };
    let name = if is_static {
        format!("<static initializer {index}>")
    } else {
        format!("<initializer {index}>")
    };
    let member_range = member.range();
    let member_certainty = certainty(recovery_ranges, &member_range, &ownership);
    OutlineMember {
        entry: OutlineEntry {
            role: EntryRole::Member,
            symbol_type: SymbolType::Event,
            name: name.clone(),
            qualified_name: format!("{parent_name}.{name}"),
            range: source_range(source.as_bytes(), member_range.clone()),
            name_range: source_range(source.as_bytes(), member_range.clone()),
            receiver_range: None,
            body_range: Some(source_range(source.as_bytes(), body.range())),
            signature: if is_static {
                "static { … }".to_owned()
            } else {
                "{ … }".to_owned()
            },
            ast_kind: member.kind().into_owned(),
            certainty: member_certainty,
            certainty_reason: certainty_reason(member_certainty),
            locator: None,
        },
        is_public: false,
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
    let signature = source[bytes].trim().to_owned();
    let name_node = (row_kind == OutlineRowKind::Package)
        .then(|| {
            node.children()
                .find(|child| matches!(child.kind().as_ref(), "identifier" | "scoped_identifier"))
        })
        .flatten();
    let name = if let Some(name_node) = &name_node {
        name_node.text().into_owned()
    } else if row_kind == OutlineRowKind::Import {
        "import".to_owned()
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
            name_range: name_node
                .map_or(range, |name| source_range(source.as_bytes(), name.range())),
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
        is_exported: false,
        members: Vec::new(),
    }
}

fn used_java_names<D: ast_grep_core::Doc>(
    root: Node<D>,
    ranges: &[SourceRange],
) -> BTreeSet<String> {
    root.dfs()
        .filter(|node| matches!(node.kind().as_ref(), "identifier" | "type_identifier"))
        .filter(|node| {
            let bytes = node.range();
            ranges
                .iter()
                .any(|range| bytes.start >= range.start_byte && bytes.end <= range.end_byte)
        })
        .map(|node| node.text().into_owned())
        .collect()
}

fn java_import_is_used<D: ast_grep_core::Doc>(
    declaration: Node<D>,
    used_names: &BTreeSet<String>,
) -> bool {
    if declaration.dfs().any(|node| node.kind() == "asterisk") {
        return true;
    }
    declaration
        .dfs()
        .filter(|node| matches!(node.kind().as_ref(), "identifier" | "type_identifier"))
        .last()
        .is_some_and(|binding| used_names.contains(binding.text().trim()))
}

fn attached_doc_start<D: ast_grep_core::Doc>(node: Node<D>, source: &str) -> Option<usize> {
    let previous = node.prev()?;
    if previous.kind() != "block_comment"
        || !previous.text().starts_with("/**")
        || previous.end_pos().line() + 1 < node.start_pos().line()
        || !source[previous.range().end..node.range().start]
            .lines()
            .all(|line| line.trim().is_empty())
    {
        return None;
    }
    Some(previous.range().start)
}

fn member_public<D: ast_grep_core::Doc>(node: &Node<D>, parent_kind: &str) -> bool {
    if has_access(node, "private") || has_access(node, "protected") {
        return false;
    }
    is_interface_like(parent_kind) || has_access(node, "public")
}

fn has_access<D: ast_grep_core::Doc>(node: &Node<D>, access: &str) -> bool {
    node.children()
        .find(|child| child.kind() == "modifiers")
        .is_some_and(|modifiers| {
            modifiers
                .children()
                .any(|modifier| modifier.kind() == access)
        })
}

fn is_interface_like(kind: &str) -> bool {
    matches!(
        kind,
        "interface_declaration" | "annotation_type_declaration"
    )
}

fn is_type_declaration(kind: &str) -> bool {
    matches!(
        kind,
        "class_declaration"
            | "interface_declaration"
            | "record_declaration"
            | "enum_declaration"
            | "annotation_type_declaration"
    )
}

fn type_symbol(kind: &str) -> SymbolType {
    match kind {
        "interface_declaration" | "annotation_type_declaration" => SymbolType::Interface,
        "record_declaration" => SymbolType::Struct,
        "enum_declaration" => SymbolType::Enum,
        _ => SymbolType::Class,
    }
}

fn is_container_symbol(symbol_type: SymbolType) -> bool {
    matches!(
        symbol_type,
        SymbolType::Class | SymbolType::Struct | SymbolType::Interface | SymbolType::Enum
    )
}
