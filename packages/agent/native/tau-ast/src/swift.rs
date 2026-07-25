use crate::{
    outline::{
        EntryRole, OutlineEntry, OutlineItem, OutlineMember, OutlineRowKind, ParseCertainty,
        SourceRange, SymbolType,
    },
    source::{certainty, certainty_reason, dedent, indent, source_range},
};
use ast_grep_core::Node;
use std::collections::BTreeSet;

pub fn extract_swift_items<D: ast_grep_core::Doc>(
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
            "comment" | "multiline_comment" => {}
            "import_declaration" => items.push(import_item(node, source)),
            "class_declaration" | "protocol_declaration" => items.extend(container_item(
                node,
                source,
                &recovery_ranges,
                include_docs,
                EntryRole::Item,
                "",
                true,
                false,
                false,
            )),
            "function_declaration" => items.extend(callable_item(
                node,
                source,
                &recovery_ranges,
                include_docs,
                EntryRole::Item,
                "",
                true,
                false,
                SymbolType::Function,
                "",
            )),
            "property_declaration" => items.extend(property_items(
                node,
                source,
                &recovery_ranges,
                include_docs,
                EntryRole::Item,
                "",
                true,
                false,
            )),
            "typealias_declaration" => items.extend(simple_item(
                node,
                source,
                &recovery_ranges,
                include_docs,
                EntryRole::Item,
                "",
                true,
                false,
                SymbolType::Struct,
            )),
            "operator_declaration" | "precedence_group_declaration" => items.push(
                named_operator_item(node, source, &recovery_ranges, include_docs),
            ),
            _ => items.push(structural_item(node, source)),
        }
    }
    items
}

pub fn filter_swift_items<D: ast_grep_core::Doc>(
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
            include_private || item.is_exported || !item.members.is_empty()
        });
        return;
    }

    let mut selected_ranges = Vec::new();
    items.retain_mut(|item| match item.row_kind {
        OutlineRowKind::Import => false,
        OutlineRowKind::Package | OutlineRowKind::Export | OutlineRowKind::SideEffect => false,
        OutlineRowKind::Declaration => {
            let visible = include_private
                || item.is_exported
                || item.entry.symbol_type == SymbolType::Namespace;
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
                let below_matching_container = matching_containers.iter().any(|container| {
                    member.entry.qualified_name == *container
                        || member
                            .entry
                            .qualified_name
                            .strip_prefix(container)
                            .is_some_and(|suffix| suffix.starts_with('.'))
                });
                (include_private || member.is_public)
                    && (item_matches
                        || below_matching_container
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

    let used_names = used_swift_names(root.clone(), &selected_ranges);
    items.extend(
        root.children()
            .filter(|node| node.kind() == "import_declaration")
            .filter(|node| swift_import_is_used(node.clone(), &used_names))
            .map(|node| import_item(node, source)),
    );
    items.sort_by_key(|item| item.entry.range.start_byte);
}

pub fn finalize_swift_signatures(items: &mut [OutlineItem]) {
    for item in items {
        if item.row_kind != OutlineRowKind::Declaration
            || !is_container(item.entry.symbol_type)
            || item.entry.body_range.is_none()
        {
            continue;
        }
        let header = item.entry.signature.trim_end();
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
        item.entry.signature = if members.is_empty() {
            format!("{header}}}")
        } else {
            format!("{header}\n{members}\n}}")
        };
    }
}

pub fn matching_swift_imports<'a, D: ast_grep_core::Doc>(
    root: Node<D>,
    source: &'a str,
    declaration: &SourceRange,
) -> Vec<&'a str> {
    let used_names = used_swift_names(root.clone(), std::slice::from_ref(declaration));
    root.children()
        .filter(|node| node.kind() == "import_declaration")
        .filter(|node| swift_import_is_used(node.clone(), &used_names))
        .map(|node| &source[node.range()])
        .collect()
}

#[allow(clippy::too_many_arguments)]
fn container_item<D: ast_grep_core::Doc>(
    node: Node<D>,
    source: &str,
    recovery_ranges: &[std::ops::Range<usize>],
    include_docs: bool,
    role: EntryRole,
    parent_name: &str,
    parent_public: bool,
    default_public: bool,
    nested: bool,
) -> Option<OutlineItem> {
    let kind = container_kind(node.clone(), source);
    let name_node = node.field("name").or_else(|| {
        node.children()
            .find(|child| matches!(child.kind().as_ref(), "type_identifier" | "user_type"))
    })?;
    let name = name_node.text().into_owned();
    let qualified_name = if kind == ContainerKind::Extension {
        extension_qualified_name(node.clone(), source)
    } else {
        qualify(parent_name, &name)
    };
    let explicit_access = access_level(&node);
    let directly_public =
        explicit_access.is_public() || (explicit_access == AccessLevel::Default && default_public);
    let effectively_public = parent_public && directly_public;
    let member_default_public = match kind {
        ContainerKind::Protocol => effectively_public,
        ContainerKind::Extension => directly_public,
        _ => false,
    };
    let member_parent_public = kind == ContainerKind::Extension || effectively_public;
    let body = node.field("body").or_else(|| {
        node.children()
            .find(|child| is_body_kind(child.kind().as_ref()))
    });
    let mut members = body.as_ref().map_or_else(Vec::new, |body| {
        container_members(
            body.clone(),
            source,
            recovery_ranges,
            include_docs,
            &qualified_name,
            member_default_public,
            member_parent_public,
            kind == ContainerKind::Protocol,
        )
    });
    let exported = if kind == ContainerKind::Extension {
        directly_public || members.iter().any(|member| member.is_public)
    } else {
        effectively_public
    };
    let entry = container_entry(
        node,
        name_node,
        name,
        qualified_name,
        source,
        recovery_ranges,
        include_docs,
        role,
        kind.symbol_type(),
        body,
        nested,
    );
    members.sort_by_key(|member| member.entry.range.start_byte);
    Some(OutlineItem {
        entry,
        row_kind: OutlineRowKind::Declaration,
        is_import: false,
        is_exported: exported,
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
    let ownership = node.range();
    let start = attached_doc_start(ownership.start, source).unwrap_or(ownership.start);
    let declaration = start..ownership.end;
    let item_certainty = certainty(recovery_ranges, &declaration, &ownership);
    let signature_start = if include_docs { start } else { ownership.start };
    let signature = body.as_ref().map_or_else(
        || source[signature_start..ownership.end].trim().to_owned(),
        |body| {
            let mut header = container_header(source, signature_start, body.range().start);
            if nested {
                header.push_str(" … }");
            }
            header
        },
    );
    OutlineEntry {
        role,
        symbol_type,
        name,
        qualified_name,
        range: source_range(source.as_bytes(), declaration),
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
fn container_members<D: ast_grep_core::Doc>(
    body: Node<D>,
    source: &str,
    recovery_ranges: &[std::ops::Range<usize>],
    include_docs: bool,
    parent_name: &str,
    default_public: bool,
    parent_public: bool,
    protocol_body: bool,
) -> Vec<OutlineMember> {
    let mut members = Vec::new();
    for node in body.children().filter(|node| node.is_named()) {
        let mut extracted = match node.kind().as_ref() {
            "comment" | "multiline_comment" | "directive" | "import_declaration" => Vec::new(),
            "class_declaration" | "protocol_declaration" => container_item(
                node,
                source,
                recovery_ranges,
                include_docs,
                EntryRole::Member,
                parent_name,
                parent_public,
                default_public,
                true,
            )
            .map(|item| {
                let mut nested = vec![OutlineMember {
                    is_public: item.is_exported,
                    entry: item.entry,
                }];
                nested.extend(item.members);
                nested
            })
            .unwrap_or_default(),
            "function_declaration" | "protocol_function_declaration" => callable_item(
                node,
                source,
                recovery_ranges,
                include_docs,
                EntryRole::Member,
                parent_name,
                parent_public,
                default_public,
                SymbolType::Method,
                "",
            )
            .map(item_member)
            .into_iter()
            .collect(),
            "init_declaration" => callable_item(
                node,
                source,
                recovery_ranges,
                include_docs,
                EntryRole::Member,
                parent_name,
                parent_public,
                default_public,
                SymbolType::Constructor,
                "init",
            )
            .map(item_member)
            .into_iter()
            .collect(),
            "deinit_declaration" => callable_item(
                node,
                source,
                recovery_ranges,
                include_docs,
                EntryRole::Member,
                parent_name,
                parent_public,
                default_public,
                SymbolType::Constructor,
                "deinit",
            )
            .map(item_member)
            .into_iter()
            .collect(),
            "subscript_declaration" => callable_item(
                node,
                source,
                recovery_ranges,
                include_docs,
                EntryRole::Member,
                parent_name,
                parent_public,
                default_public,
                SymbolType::Operator,
                "subscript",
            )
            .map(item_member)
            .into_iter()
            .collect(),
            "property_declaration" | "protocol_property_declaration" => property_items(
                node,
                source,
                recovery_ranges,
                include_docs,
                EntryRole::Member,
                parent_name,
                parent_public,
                default_public,
            )
            .into_iter()
            .map(item_member)
            .collect(),
            "typealias_declaration" => simple_item(
                node,
                source,
                recovery_ranges,
                include_docs,
                EntryRole::Member,
                parent_name,
                parent_public,
                default_public,
                SymbolType::Struct,
            )
            .map(item_member)
            .into_iter()
            .collect(),
            "associatedtype_declaration" => simple_item(
                node,
                source,
                recovery_ranges,
                include_docs,
                EntryRole::Member,
                parent_name,
                parent_public,
                protocol_body && parent_public,
                SymbolType::TypeParameter,
            )
            .map(item_member)
            .into_iter()
            .collect(),
            "enum_entry" => enum_members(
                node,
                source,
                recovery_ranges,
                include_docs,
                parent_name,
                parent_public,
                body.range(),
            ),
            _ => Vec::new(),
        };
        members.append(&mut extracted);
    }
    members
}

#[allow(clippy::too_many_arguments)]
fn callable_item<D: ast_grep_core::Doc>(
    node: Node<D>,
    source: &str,
    recovery_ranges: &[std::ops::Range<usize>],
    include_docs: bool,
    role: EntryRole,
    parent_name: &str,
    parent_public: bool,
    default_public: bool,
    symbol_type: SymbolType,
    fixed_name: &str,
) -> Option<OutlineItem> {
    let name_node = if fixed_name.is_empty() {
        node.field("name").or_else(|| {
            node.children().find(|child| {
                matches!(
                    child.kind().as_ref(),
                    "simple_identifier"
                        | "type_identifier"
                        | "user_type"
                        | "custom_operator"
                        | "bang"
                )
            })
        })?
    } else {
        node.children()
            .find(|child| child.kind() == fixed_name)
            .unwrap_or_else(|| node.clone())
    };
    let name = if fixed_name.is_empty() {
        name_node.text().into_owned()
    } else {
        fixed_name.to_owned()
    };
    let qualified_name = qualify(parent_name, &name);
    let ownership = node.range();
    let start = attached_doc_start(ownership.start, source).unwrap_or(ownership.start);
    let declaration = start..ownership.end;
    let body = node
        .field("body")
        .or_else(|| {
            node.children()
                .find(|child| child.kind() == "function_body")
        })
        .or_else(|| {
            node.children()
                .find(|child| child.kind() == "computed_property")
        })
        .filter(|body| {
            body.kind() != "computed_property"
                || body.dfs().any(|child| child.kind() == "statements")
        });
    let signature_start = if include_docs { start } else { ownership.start };
    let mut signature = body.as_ref().map_or_else(
        || source[signature_start..ownership.end].trim().to_owned(),
        |body| {
            source[signature_start..body.range().start]
                .trim_end()
                .to_owned()
        },
    );
    if role == EntryRole::Member {
        signature = dedent(&signature, node.start_pos().column(&node));
    }
    let item_certainty = certainty(recovery_ranges, &declaration, &ownership);
    let public = parent_public
        && (access_level(&node).is_public()
            || (access_level(&node) == AccessLevel::Default && default_public));
    Some(OutlineItem {
        entry: OutlineEntry {
            role,
            symbol_type,
            name,
            qualified_name,
            range: source_range(source.as_bytes(), declaration),
            name_range: source_range(source.as_bytes(), name_node.range()),
            receiver_range: None,
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
fn property_items<D: ast_grep_core::Doc>(
    node: Node<D>,
    source: &str,
    recovery_ranges: &[std::ops::Range<usize>],
    include_docs: bool,
    role: EntryRole,
    parent_name: &str,
    parent_public: bool,
    default_public: bool,
) -> Vec<OutlineItem> {
    let names = node
        .field_children("name")
        .flat_map(|pattern| {
            pattern
                .dfs()
                .filter(|child| child.kind() == "simple_identifier")
                .collect::<Vec<_>>()
        })
        .collect::<Vec<_>>();
    let ownership = node.range();
    let start = attached_doc_start(ownership.start, source).unwrap_or(ownership.start);
    let declaration = start..ownership.end;
    let mut bodies = node
        .field_children("computed_value")
        .chain(
            node.children()
                .filter(|child| child.kind() == "willset_didset_block"),
        )
        .chain(node.field_children("value"))
        .collect::<Vec<_>>();
    bodies.sort_by_key(|body| body.range().start);
    let signature_start = if include_docs { start } else { ownership.start };
    let mut signature = source[signature_start..ownership.end].to_owned();
    for body in bodies.iter().rev() {
        let range = body.range();
        let relative_start = range.start - signature_start;
        let relative_end = range.end - signature_start;
        let marker = if matches!(
            body.kind().as_ref(),
            "computed_property" | "willset_didset_block"
        ) {
            "{ … }"
        } else {
            "…"
        };
        signature.replace_range(relative_start..relative_end, marker);
    }
    signature = signature.trim().to_owned();
    if role == EntryRole::Member {
        signature = dedent(&signature, node.start_pos().column(&node));
    }
    let item_certainty = certainty(recovery_ranges, &declaration, &ownership);
    let public = parent_public
        && (access_level(&node).is_public()
            || (access_level(&node) == AccessLevel::Default && default_public));
    names
        .into_iter()
        .map(|name_node| {
            let name = name_node.text().into_owned();
            OutlineItem {
                entry: OutlineEntry {
                    role,
                    symbol_type: SymbolType::Property,
                    qualified_name: qualify(parent_name, &name),
                    name: name.clone(),
                    range: source_range(source.as_bytes(), declaration.clone()),
                    name_range: source_range(source.as_bytes(), name_node.range()),
                    receiver_range: None,
                    body_range: (bodies.len() == 1)
                        .then(|| source_range(source.as_bytes(), bodies[0].range())),
                    signature: signature.clone(),
                    ast_kind: node.kind().into_owned(),
                    certainty: item_certainty,
                    certainty_reason: certainty_reason(item_certainty),
                    locator: None,
                },
                row_kind: OutlineRowKind::Declaration,
                is_import: false,
                is_exported: public,
                members: Vec::new(),
            }
        })
        .collect()
}

#[allow(clippy::too_many_arguments)]
fn simple_item<D: ast_grep_core::Doc>(
    node: Node<D>,
    source: &str,
    recovery_ranges: &[std::ops::Range<usize>],
    include_docs: bool,
    role: EntryRole,
    parent_name: &str,
    parent_public: bool,
    default_public: bool,
    symbol_type: SymbolType,
) -> Option<OutlineItem> {
    let name_node = node.field("name")?;
    let name = name_node.text().into_owned();
    let ownership = node.range();
    let start = attached_doc_start(ownership.start, source).unwrap_or(ownership.start);
    let declaration = start..ownership.end;
    let signature_start = if include_docs { start } else { ownership.start };
    let mut signature = source[signature_start..ownership.end].trim().to_owned();
    if role == EntryRole::Member {
        signature = dedent(&signature, node.start_pos().column(&node));
    }
    let item_certainty = certainty(recovery_ranges, &declaration, &ownership);
    let public = parent_public
        && (access_level(&node).is_public()
            || (access_level(&node) == AccessLevel::Default && default_public));
    Some(OutlineItem {
        entry: OutlineEntry {
            role,
            symbol_type,
            name: name.clone(),
            qualified_name: qualify(parent_name, &name),
            range: source_range(source.as_bytes(), declaration),
            name_range: source_range(source.as_bytes(), name_node.range()),
            receiver_range: None,
            body_range: None,
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

fn enum_members<D: ast_grep_core::Doc>(
    node: Node<D>,
    source: &str,
    recovery_ranges: &[std::ops::Range<usize>],
    include_docs: bool,
    parent_name: &str,
    parent_public: bool,
    ownership: std::ops::Range<usize>,
) -> Vec<OutlineMember> {
    let start = attached_doc_start(node.range().start, source).unwrap_or(node.range().start);
    let declaration = start..node.range().end;
    let signature_start = if include_docs {
        start
    } else {
        node.range().start
    };
    let item_certainty = certainty(recovery_ranges, &declaration, &ownership);
    let access = access_level(&node);
    let public = parent_public
        && !matches!(
            access,
            AccessLevel::Package
                | AccessLevel::Internal
                | AccessLevel::Fileprivate
                | AccessLevel::Private
        );
    let names = node.field_children("name").collect::<Vec<_>>();
    names
        .iter()
        .enumerate()
        .map(|(index, name_node)| {
            let name = name_node.text().into_owned();
            let segment_end = names.get(index + 1).map_or(node.range().end, |next| {
                source[name_node.range().end..next.range().start]
                    .rfind(',')
                    .map_or(next.range().start, |comma| name_node.range().end + comma)
            });
            let raw_signature = if index == 0 {
                &source[signature_start..segment_end]
            } else {
                &source[name_node.range().start..segment_end]
            };
            let member_signature = if index == 0 {
                raw_signature.trim().trim_end_matches(',').to_owned()
            } else {
                format!("case {}", raw_signature.trim().trim_end_matches(','))
            };
            OutlineMember {
                is_public: public,
                entry: OutlineEntry {
                    role: EntryRole::Member,
                    symbol_type: SymbolType::EnumMember,
                    qualified_name: qualify(parent_name, &name),
                    name: name.clone(),
                    range: source_range(source.as_bytes(), declaration.clone()),
                    name_range: source_range(source.as_bytes(), name_node.range()),
                    receiver_range: None,
                    body_range: None,
                    signature: dedent(&member_signature, node.start_pos().column(&node)),
                    ast_kind: node.kind().into_owned(),
                    certainty: item_certainty,
                    certainty_reason: certainty_reason(item_certainty),
                    locator: None,
                },
            }
        })
        .collect()
}

fn named_operator_item<D: ast_grep_core::Doc>(
    node: Node<D>,
    source: &str,
    recovery_ranges: &[std::ops::Range<usize>],
    include_docs: bool,
) -> OutlineItem {
    let name_node = node
        .children()
        .find(|child| {
            matches!(
                child.kind().as_ref(),
                "custom_operator" | "simple_identifier"
            )
        })
        .unwrap_or_else(|| node.clone());
    let name = name_node.text().into_owned();
    let ownership = node.range();
    let start = attached_doc_start(ownership.start, source).unwrap_or(ownership.start);
    let declaration = start..ownership.end;
    let signature_start = if include_docs { start } else { ownership.start };
    let item_certainty = certainty(recovery_ranges, &declaration, &ownership);
    OutlineItem {
        entry: OutlineEntry {
            role: EntryRole::Item,
            symbol_type: SymbolType::Operator,
            name: name.clone(),
            qualified_name: name,
            range: source_range(source.as_bytes(), declaration),
            name_range: source_range(source.as_bytes(), name_node.range()),
            receiver_range: None,
            body_range: None,
            signature: source[signature_start..ownership.end].trim().to_owned(),
            ast_kind: node.kind().into_owned(),
            certainty: item_certainty,
            certainty_reason: certainty_reason(item_certainty),
            locator: None,
        },
        row_kind: OutlineRowKind::Declaration,
        is_import: false,
        is_exported: true,
        members: Vec::new(),
    }
}

fn import_item<D: ast_grep_core::Doc>(node: Node<D>, source: &str) -> OutlineItem {
    let bytes = node.range();
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

fn structural_item<D: ast_grep_core::Doc>(node: Node<D>, source: &str) -> OutlineItem {
    let bytes = node.range();
    let range = source_range(source.as_bytes(), bytes.clone());
    let name = node.kind().replace('_', " ");
    OutlineItem {
        entry: OutlineEntry {
            role: EntryRole::Item,
            symbol_type: SymbolType::Event,
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
        row_kind: OutlineRowKind::SideEffect,
        is_import: false,
        is_exported: false,
        members: Vec::new(),
    }
}

fn item_member(item: OutlineItem) -> OutlineMember {
    OutlineMember {
        is_public: item.is_exported,
        entry: item.entry,
    }
}

fn used_swift_names<D: ast_grep_core::Doc>(
    root: Node<D>,
    ranges: &[SourceRange],
) -> BTreeSet<String> {
    let in_selected_range = |node: &Node<D>| {
        let bytes = node.range();
        ranges
            .iter()
            .any(|range| bytes.start >= range.start_byte && bytes.end <= range.end_byte)
    };
    root.dfs()
        .filter(|node| {
            matches!(
                node.kind().as_ref(),
                "simple_identifier" | "type_identifier"
            )
        })
        .filter(in_selected_range)
        .map(|node| node.text().trim_matches('`').to_owned())
        .collect()
}

fn swift_import_is_used<D: ast_grep_core::Doc>(
    declaration: Node<D>,
    used_names: &BTreeSet<String>,
) -> bool {
    let text = declaration.text();
    let Some(after_import) = text.split_once("import").map(|(_, suffix)| suffix.trim()) else {
        return true;
    };
    let mut words = after_import.split_whitespace();
    let first = words.next().unwrap_or_default();
    if !matches!(
        first,
        "typealias" | "struct" | "class" | "enum" | "protocol" | "let" | "var" | "func"
    ) {
        return true;
    }
    words
        .next()
        .and_then(|path| path.rsplit('.').next())
        .is_some_and(|binding| used_names.contains(binding))
}

fn attached_doc_start(node_start: usize, source: &str) -> Option<usize> {
    let before = &source[..node_start];
    let trimmed_end = before.trim_end().len();
    if before[trimmed_end..]
        .bytes()
        .filter(|byte| *byte == b'\n')
        .count()
        > 1
    {
        return None;
    }
    let trimmed = &before[..trimmed_end];
    if trimmed.ends_with("*/") {
        let start = trimmed.rfind("/*")?;
        return trimmed[start..].starts_with("/**").then_some(start);
    }

    let mut start = trimmed_end;
    let mut cursor = trimmed_end;
    while cursor > 0 {
        let line_start = before[..cursor]
            .rfind('\n')
            .map_or(0, |newline| newline + 1);
        let line = &before[line_start..cursor];
        if !line.trim_start().starts_with("///") {
            break;
        }
        start = line_start;
        if line_start == 0 {
            break;
        }
        cursor = line_start - 1;
    }
    (start < trimmed_end).then_some(start)
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

fn extension_qualified_name<D: ast_grep_core::Doc>(node: Node<D>, source: &str) -> String {
    let body_start = node
        .field("body")
        .map_or(node.range().end, |body| body.range().start);
    let header = source[node.range().start..body_start].trim();
    let target = header
        .split_once("extension ")
        .map_or(header, |(_, target)| target);
    format!("extension {target}")
}

fn qualify(parent: &str, name: &str) -> String {
    if parent.is_empty() {
        name.to_owned()
    } else {
        format!("{parent}.{name}")
    }
}

fn is_body_kind(kind: &str) -> bool {
    matches!(kind, "class_body" | "enum_class_body" | "protocol_body")
}

fn is_container(symbol_type: SymbolType) -> bool {
    matches!(
        symbol_type,
        SymbolType::Class
            | SymbolType::Interface
            | SymbolType::Enum
            | SymbolType::Namespace
            | SymbolType::Struct
    )
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum ContainerKind {
    Struct,
    Class,
    Actor,
    Enum,
    Extension,
    Protocol,
}

impl ContainerKind {
    fn symbol_type(self) -> SymbolType {
        match self {
            Self::Struct => SymbolType::Struct,
            Self::Class | Self::Actor => SymbolType::Class,
            Self::Enum => SymbolType::Enum,
            Self::Extension => SymbolType::Namespace,
            Self::Protocol => SymbolType::Interface,
        }
    }
}

fn container_kind<D: ast_grep_core::Doc>(node: Node<D>, source: &str) -> ContainerKind {
    if node.kind() == "protocol_declaration" {
        return ContainerKind::Protocol;
    }
    let declaration_kind = node
        .field("declaration_kind")
        .map(|kind| kind.text().into_owned())
        .unwrap_or_else(|| {
            let name_start = node
                .field("name")
                .map_or(node.range().end, |name| name.range().start);
            source[node.range().start..name_start]
                .split_whitespace()
                .find(|word| matches!(*word, "struct" | "class" | "actor" | "enum" | "extension"))
                .unwrap_or("class")
                .to_owned()
        });
    if declaration_kind == "struct" {
        ContainerKind::Struct
    } else if declaration_kind == "actor" {
        ContainerKind::Actor
    } else if declaration_kind == "enum" {
        ContainerKind::Enum
    } else if declaration_kind == "extension" {
        ContainerKind::Extension
    } else {
        ContainerKind::Class
    }
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum AccessLevel {
    Default,
    Open,
    Public,
    Package,
    Internal,
    Fileprivate,
    Private,
}

impl AccessLevel {
    fn is_public(self) -> bool {
        matches!(self, Self::Open | Self::Public)
    }
}

fn access_level<D: ast_grep_core::Doc>(node: &Node<D>) -> AccessLevel {
    node.children()
        .find(|child| child.kind() == "modifiers")
        .and_then(|modifiers| {
            modifiers
                .children()
                .filter(|modifier| modifier.kind() == "visibility_modifier")
                .find(|modifier| matches!(modifier.text().trim(), "open" | "public"))
                .or_else(|| {
                    modifiers
                        .children()
                        .filter(|modifier| modifier.kind() == "visibility_modifier")
                        .last()
                })
        })
        .map_or(AccessLevel::Default, |modifier| {
            match modifier.text().trim() {
                "open" => AccessLevel::Open,
                "public" => AccessLevel::Public,
                "package" => AccessLevel::Package,
                "internal" => AccessLevel::Internal,
                "fileprivate" => AccessLevel::Fileprivate,
                "private" => AccessLevel::Private,
                _ => AccessLevel::Default,
            }
        })
}
