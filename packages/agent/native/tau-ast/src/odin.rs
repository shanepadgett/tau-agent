use crate::{
    outline::{
        EntryRole, OutlineEntry, OutlineItem, OutlineMember, OutlineRowKind, ParseCertainty,
        SourceRange, SymbolType,
    },
    source::{certainty, certainty_reason, dedent, indent, source_range},
};
use ast_grep_core::Node;
use std::collections::BTreeSet;

pub fn extract_odin_items<D: ast_grep_core::Doc>(
    root: Node<D>,
    source: &str,
    include_docs: bool,
) -> Vec<OutlineItem> {
    let recovery_ranges = root
        .dfs()
        .filter(|node| node.is_error() || node.is_missing())
        .map(|node| node.range())
        .collect::<Vec<_>>();
    let file_public = !root
        .children()
        .any(|node| node.kind() == "build_tag" && node.text().contains("private"));
    let mut items = Vec::new();
    extract_scope(
        root.children().filter(|node| node.is_named()).collect(),
        source,
        &recovery_ranges,
        include_docs,
        file_public,
        &mut items,
    );
    items.sort_by_key(|item| item.entry.range.start_byte);
    items
}

pub fn filter_odin_items<D: ast_grep_core::Doc>(
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
                visible
                    && (include_private || member.is_public)
                    && (item_matches
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
    for node in root
        .dfs()
        .filter(|node| node.kind() == "import_declaration")
        .filter(|node| import_is_used(node.clone(), &used_names))
    {
        items.push(structural_item(
            node,
            source,
            OutlineRowKind::Import,
            SymbolType::Module,
        ));
    }
    items.sort_by_key(|item| item.entry.range.start_byte);
}

pub fn finalize_odin_signatures(items: &mut [OutlineItem]) {
    for item in items {
        if item.row_kind != OutlineRowKind::Declaration || item.entry.body_range.is_none() {
            continue;
        }
        if !matches!(
            item.entry.symbol_type,
            SymbolType::Struct | SymbolType::Enum | SymbolType::Namespace
        ) {
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
            format!("{header}\n{members}\n}}")
        };
    }
}

pub fn matching_odin_imports<'a, D: ast_grep_core::Doc>(
    root: Node<D>,
    source: &'a str,
    declaration: &SourceRange,
) -> Vec<&'a str> {
    let names = used_names(root.clone(), std::slice::from_ref(declaration));
    root.dfs()
        .filter(|node| node.kind() == "import_declaration")
        .filter(|node| import_is_used(node.clone(), &names))
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
    include_docs: bool,
    parent_public: bool,
    items: &mut Vec<OutlineItem>,
) {
    for node in nodes {
        match node.kind().as_ref() {
            "comment" | "block_comment" => {}
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
            "foreign_block" => {
                if let Some(item) = foreign_item(
                    node,
                    source,
                    recovery_ranges,
                    include_docs,
                    parent_public,
                ) {
                    items.push(item);
                }
            }
            "when_statement" => {
                items.push(redacted_structural_item(node.clone(), source));
                for block in clause_blocks(node) {
                    extract_scope(
                        block.children().filter(|child| child.is_named()).collect(),
                        source,
                        recovery_ranges,
                        include_docs,
                        parent_public,
                        items,
                    );
                }
            }
            kind if is_declaration(kind) => {
                items.extend(declaration_items(
                    node,
                    source,
                    recovery_ranges,
                    include_docs,
                    EntryRole::Item,
                    "",
                    parent_public,
                ));
            }
            _ => items.push(redacted_structural_item(node, source)),
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn declaration_item<'tree, D: ast_grep_core::Doc>(
    node: Node<'tree, D>,
    source: &str,
    recovery_ranges: &[std::ops::Range<usize>],
    include_docs: bool,
    role: EntryRole,
    parent_name: &str,
    parent_public: bool,
    name_override: Option<Node<'tree, D>>,
) -> Option<OutlineItem> {
    let name_node = name_override.or_else(|| declaration_name(node.clone()))?;
    let name = name_node.text().trim().to_owned();
    let qualified_name = qualify(parent_name, &name);
    let node_range = node.range();
    let start_byte = attached_doc_start(node.clone(), source).unwrap_or(node_range.start);
    let declaration_range = start_byte..node_range.end;
    let public = parent_public && !has_private_attribute(&node);
    let symbol_type = declaration_symbol(node.kind().as_ref(), &node);
    let body = declaration_body(node.clone(), source);
    let signature_start = if include_docs {
        start_byte
    } else {
        node_range.start
    };
    let signature = declaration_signature(
        node.clone(),
        source,
        signature_start,
        body.as_ref(),
        symbol_type,
    );
    let ownership = node_range.clone();
    let declaration_certainty = certainty(recovery_ranges, &declaration_range, &ownership);
    let members = container_members(
        node.clone(),
        source,
        recovery_ranges,
        include_docs,
        &qualified_name,
        public,
        body.as_ref().map(|range| range.start..range.end),
    );
    Some(OutlineItem {
        entry: OutlineEntry {
            role,
            symbol_type,
            name,
            qualified_name,
            range: source_range(source.as_bytes(), declaration_range),
            name_range: source_range(source.as_bytes(), name_node.range()),
            receiver_range: None,
            body_range: body.map(|range| source_range(source.as_bytes(), range)),
            signature,
            ast_kind: node.kind().into_owned(),
            certainty: declaration_certainty,
            certainty_reason: certainty_reason(declaration_certainty),
            locator: None,
        },
        row_kind: OutlineRowKind::Declaration,
        is_import: false,
        is_exported: public,
        members,
    })
}

#[allow(clippy::too_many_arguments)]
fn declaration_items<D: ast_grep_core::Doc>(
    node: Node<D>,
    source: &str,
    recovery_ranges: &[std::ops::Range<usize>],
    include_docs: bool,
    role: EntryRole,
    parent_name: &str,
    parent_public: bool,
) -> Vec<OutlineItem> {
    declaration_names(node.clone(), source)
        .into_iter()
        .filter_map(|name| {
            declaration_item(
                node.clone(),
                source,
                recovery_ranges,
                include_docs,
                role,
                parent_name,
                parent_public,
                Some(name),
            )
        })
        .collect()
}

fn foreign_item<D: ast_grep_core::Doc>(
    node: Node<D>,
    source: &str,
    recovery_ranges: &[std::ops::Range<usize>],
    include_docs: bool,
    parent_public: bool,
) -> Option<OutlineItem> {
    let block = node.children().find(|child| child.kind() == "block")?;
    let identifier = node
        .children()
        .find(|child| child.kind() == "identifier");
    let name = identifier.as_ref().map_or_else(
        || "foreign".to_owned(),
        |identifier| format!("foreign {}", identifier.text().trim()),
    );
    let node_range = node.range();
    let start_byte = attached_doc_start(node.clone(), source).unwrap_or(node_range.start);
    let declaration_range = start_byte..node_range.end;
    let public = parent_public && !has_private_attribute(&node);
    let signature_start = if include_docs {
        start_byte
    } else {
        node_range.start
    };
    let signature = dedent(
        source[signature_start..=block.range().start].trim_end(),
        node.start_pos().column(&node),
    );
    let mut members = Vec::new();
    for child in block.children().filter(|child| child.is_named()) {
        if !is_declaration(child.kind().as_ref()) {
            continue;
        }
        for item in declaration_items(
            child,
            source,
            recovery_ranges,
            include_docs,
            EntryRole::Member,
            &name,
            public,
        ) {
            members.push(OutlineMember {
                entry: item.entry,
                is_public: item.is_exported,
            });
            members.extend(item.members);
        }
    }
    let declaration_certainty = certainty(recovery_ranges, &declaration_range, &node_range);
    let name_range = identifier.map_or_else(
        || source_range(source.as_bytes(), node_range.start..node_range.start + "foreign".len()),
        |identifier| source_range(source.as_bytes(), identifier.range()),
    );
    Some(OutlineItem {
        entry: OutlineEntry {
            role: EntryRole::Item,
            symbol_type: SymbolType::Namespace,
            name: name.clone(),
            qualified_name: name,
            range: source_range(source.as_bytes(), declaration_range),
            name_range,
            receiver_range: None,
            body_range: Some(source_range(source.as_bytes(), block.range())),
            signature,
            ast_kind: node.kind().into_owned(),
            certainty: declaration_certainty,
            certainty_reason: certainty_reason(declaration_certainty),
            locator: None,
        },
        row_kind: OutlineRowKind::Declaration,
        is_import: false,
        is_exported: public,
        members,
    })
}

fn container_members<D: ast_grep_core::Doc>(
    node: Node<D>,
    source: &str,
    recovery_ranges: &[std::ops::Range<usize>],
    include_docs: bool,
    parent_name: &str,
    parent_public: bool,
    body: Option<std::ops::Range<usize>>,
) -> Vec<OutlineMember> {
    let Some(body) = body else {
        return Vec::new();
    };
    match node.kind().as_ref() {
        "struct_declaration" => node
            .children()
            .filter(|child| child.kind() == "field")
            .flat_map(|field| {
                let names = field
                    .children()
                    .filter(|child| child.kind() == "identifier")
                    .collect::<Vec<_>>();
                names.into_iter().map({
                    let field = field.clone();
                    move |name| (field.clone(), name)
                })
            })
            .map(|(field, name)| {
                member(
                    field,
                    name,
                    source,
                    recovery_ranges,
                    include_docs,
                    parent_name,
                    parent_public,
                    &body,
                    SymbolType::Field,
                    true,
                )
            })
            .collect(),
        "enum_declaration" => {
            let identifiers = node
                .children()
                .filter(|child| child.kind() == "identifier")
                .collect::<Vec<_>>();
            comma_segments(&body, source)
                .into_iter()
                .filter_map(|(segment, has_comma)| {
                    let name = identifiers.iter().find(|identifier| {
                        identifier.range().start >= segment.start
                            && identifier.range().end <= segment.end
                    })?;
                    Some(segment_member(
                        name.clone(),
                        segment,
                        source,
                        recovery_ranges,
                        parent_name,
                        parent_public,
                        &body,
                        SymbolType::EnumMember,
                        has_comma,
                        include_docs,
                    ))
                })
                .collect()
        }
        "union_declaration" => {
            let types = node
                .children()
                .filter(|child| child.kind() == "type" && child.range().start > body.start)
                .collect::<Vec<_>>();
            comma_segments(&body, source)
                .into_iter()
                .filter_map(|(segment, has_comma)| {
                    let type_node = types.iter().find(|type_node| {
                        type_node.range().start >= segment.start
                            && type_node.range().end <= segment.end
                    })?;
                    Some(segment_member(
                        type_node.clone(),
                        segment,
                        source,
                        recovery_ranges,
                        parent_name,
                        parent_public,
                        &body,
                        SymbolType::Struct,
                        has_comma,
                        include_docs,
                    ))
                })
                .collect()
        }
        "bit_field_declaration" => {
            let identifiers = node
                .children()
                .filter(|child| child.kind() == "identifier")
                .collect::<Vec<_>>();
            comma_segments(&body, source)
                .into_iter()
                .filter_map(|(segment, has_comma)| {
                    let name = identifiers.iter().find(|identifier| {
                        identifier.range().start >= segment.start
                            && identifier.range().end <= segment.end
                    })?;
                    Some(segment_member(
                        name.clone(),
                        segment,
                        source,
                        recovery_ranges,
                        parent_name,
                        parent_public,
                        &body,
                        SymbolType::Field,
                        has_comma,
                        include_docs,
                    ))
                })
                .collect()
        }
        _ => Vec::new(),
    }
}

#[allow(clippy::too_many_arguments)]
fn member<D: ast_grep_core::Doc>(
    node: Node<D>,
    name_node: Node<D>,
    source: &str,
    recovery_ranges: &[std::ops::Range<usize>],
    include_docs: bool,
    parent_name: &str,
    parent_public: bool,
    ownership: &std::ops::Range<usize>,
    symbol_type: SymbolType,
    comma: bool,
) -> OutlineMember {
    let node_range = node.range();
    let start_byte = attached_doc_start(node.clone(), source)
        .filter(|start| *start >= ownership.start)
        .unwrap_or(node_range.start);
    let declaration_range = start_byte..node_range.end;
    let member_certainty = certainty(recovery_ranges, &declaration_range, ownership);
    let signature_start = if include_docs {
        start_byte
    } else {
        node_range.start
    };
    let mut signature = if node.kind() == "field" {
        let field = field_signature(node.clone(), name_node.clone(), source);
        if include_docs && start_byte < node_range.start {
            format!(
                "{}\n{field}",
                source[start_byte..node_range.start].trim_end()
            )
        } else {
            field
        }
    } else {
        dedent(
            source[signature_start..node_range.end].trim(),
            node.start_pos().column(&node),
        )
    };
    if comma {
        signature.push(',');
    }
    let name = name_node.text().trim().to_owned();
    OutlineMember {
        entry: OutlineEntry {
            role: EntryRole::Member,
            symbol_type,
            name: name.clone(),
            qualified_name: qualify(parent_name, &name),
            range: source_range(source.as_bytes(), declaration_range),
            name_range: source_range(source.as_bytes(), name_node.range()),
            receiver_range: None,
            body_range: None,
            signature,
            ast_kind: node.kind().into_owned(),
            certainty: member_certainty,
            certainty_reason: certainty_reason(member_certainty),
            locator: None,
        },
        is_public: parent_public,
    }
}

#[allow(clippy::too_many_arguments)]
fn segment_member<D: ast_grep_core::Doc>(
    name_node: Node<D>,
    bytes: std::ops::Range<usize>,
    source: &str,
    recovery_ranges: &[std::ops::Range<usize>],
    parent_name: &str,
    parent_public: bool,
    ownership: &std::ops::Range<usize>,
    symbol_type: SymbolType,
    has_comma: bool,
    include_docs: bool,
) -> OutlineMember {
    let name = name_node.text().trim().to_owned();
    let member_certainty = certainty(recovery_ranges, &bytes, ownership);
    OutlineMember {
        entry: OutlineEntry {
            role: EntryRole::Member,
            symbol_type,
            name: name.clone(),
            qualified_name: qualify(parent_name, &name.replace('.', "::")),
            range: source_range(source.as_bytes(), bytes.clone()),
            name_range: source_range(source.as_bytes(), name_node.range()),
            receiver_range: None,
            body_range: None,
            signature: if include_docs {
                if has_comma {
                    source[bytes.clone()].trim().to_owned()
                } else {
                    format!("{},", source[bytes.clone()].trim())
                }
            } else {
                let mut end = bytes.end;
                let member_source = &source[name_node.range().start..end];
                if let Some(comment) = member_source.find("//") {
                    end = name_node.range().start + comment;
                }
                if let Some(comment) = source[name_node.range().start..end].find("/*") {
                    end = name_node.range().start + comment;
                }
                let signature = source[name_node.range().start..end].trim_end();
                if has_comma || signature.ends_with(',') {
                    signature.to_owned()
                } else {
                    format!("{signature},")
                }
            },
            ast_kind: name_node.kind().into_owned(),
            certainty: member_certainty,
            certainty_reason: certainty_reason(member_certainty),
            locator: None,
        },
        is_public: parent_public,
    }
}

fn declaration_signature<D: ast_grep_core::Doc>(
    node: Node<D>,
    source: &str,
    start: usize,
    body: Option<&std::ops::Range<usize>>,
    symbol_type: SymbolType,
) -> String {
    let node_range = node.range();
    let column = node.start_pos().column(&node);
    if node.kind() == "procedure_declaration" && let Some(body) = body {
        return dedent(source[start..body.start].trim_end(), column);
    }
    if matches!(
        node.kind().as_ref(),
        "struct_declaration" | "enum_declaration" | "union_declaration" | "bit_field_declaration"
    ) && let Some(body) = body {
        return dedent(source[start..=body.start].trim_end(), column);
    }
    if matches!(
        node.kind().as_ref(),
        "variable_declaration" | "var_declaration" | "const_type_declaration"
    ) || (node.kind() == "const_declaration" && symbol_type == SymbolType::Constant)
    {
        if let Some(body) = body {
            let prefix = source[start..body.start].trim_end();
            let suffix = if source[node_range.start..body.start].trim_end().ends_with('=')
                || source[node_range.start..body.start].trim_end().ends_with(':')
            {
                " …"
            } else {
                "…"
            };
            return dedent(&format!("{prefix}{suffix}"), column);
        }
    }
    dedent(source[start..node_range.end].trim(), column)
}

fn declaration_body<D: ast_grep_core::Doc>(
    node: Node<D>,
    source: &str,
) -> Option<std::ops::Range<usize>> {
    match node.kind().as_ref() {
        "procedure_declaration" => node
            .dfs()
            .find(|child| child.kind() == "block")
            .map(|child| child.range()),
        "struct_declaration"
        | "enum_declaration"
        | "union_declaration"
        | "bit_field_declaration" => brace_range(node.range(), source),
        "variable_declaration" => initializer_after(node.range(), source, ":="),
        "var_declaration" | "const_type_declaration" => {
            let type_node = node.children().find(|child| child.kind() == "type")?;
            let initializer = node
                .children()
                .find(|child| child.is_named() && child.range().start >= type_node.range().end)?;
            trimmed_range(initializer.range().start..node.range().end, source)
        }
        "const_declaration" if declaration_symbol(node.kind().as_ref(), &node) == SymbolType::Constant => {
            initializer_after(node.range(), source, "::")
        }
        _ => None,
    }
}

fn declaration_symbol<D: ast_grep_core::Doc>(kind: &str, node: &Node<D>) -> SymbolType {
    match kind {
        "procedure_declaration" | "overloaded_procedure_declaration" => SymbolType::Function,
        "struct_declaration" => SymbolType::Struct,
        "enum_declaration" => SymbolType::Enum,
        "union_declaration" | "bit_field_declaration" => SymbolType::Struct,
        "variable_declaration" | "var_declaration" => SymbolType::Variable,
        "const_declaration"
            if (node.text().contains("#type")
                && node.children().any(|child| child.kind() == "type"))
                || node.children().any(|child| {
                matches!(
                    child.kind().as_ref(),
                    "distinct_type"
                        | "array_type"
                        | "pointer_type"
                        | "bit_set_type"
                        | "map_type"
                        | "matrix_type"
                        | "procedure_type"
                )
            }) =>
        {
            SymbolType::Struct
        }
        "const_declaration" | "const_type_declaration" => SymbolType::Constant,
        _ => SymbolType::Variable,
    }
}

fn declaration_name<D: ast_grep_core::Doc>(node: Node<D>) -> Option<Node<D>> {
    node.children()
        .find(|child| child.kind() == "identifier")
        .or_else(|| {
            node.children().find(|child| {
                !matches!(child.kind().as_ref(), "attributes" | "attribute" | "tag")
            })
        })
}

fn declaration_names<'tree, D: ast_grep_core::Doc>(
    node: Node<'tree, D>,
    source: &str,
) -> Vec<Node<'tree, D>> {
    let separator = match node.kind().as_ref() {
        "const_declaration" => "::",
        "variable_declaration" => ":=",
        "var_declaration" | "const_type_declaration" => ":",
        _ => return declaration_name(node).into_iter().collect(),
    };
    let range = node.range();
    let Some(offset) = source[range.clone()].find(separator) else {
        return declaration_name(node).into_iter().collect();
    };
    let end = range.start + offset;
    let names = node
        .children()
        .filter(|child| child.kind() == "identifier" && child.range().end <= end)
        .collect::<Vec<_>>();
    if names.is_empty() {
        declaration_name(node).into_iter().collect()
    } else {
        names
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
        .then(|| node.children().find(|child| child.kind() == "identifier"))
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

fn redacted_structural_item<D: ast_grep_core::Doc>(node: Node<D>, source: &str) -> OutlineItem {
    let mut item = structural_item(
        node.clone(),
        source,
        OutlineRowKind::SideEffect,
        SymbolType::Event,
    );
    if let Some(body) = node.children().find(|child| child.kind() == "block") {
        item.entry.signature = format!("{}… }}", source[node.range().start..=body.range().start].trim_end());
    }
    item
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

fn import_is_used<D: ast_grep_core::Doc>(
    declaration: Node<D>,
    used_names: &BTreeSet<String>,
) -> bool {
    if declaration.text().contains("@require") {
        return true;
    }
    if let Some(alias) = declaration.field("alias") {
        return used_names.contains(alias.text().trim());
    }
    declaration
        .children()
        .filter(|child| child.kind() == "string")
        .flat_map(|path| {
            let path = path.text();
            let path = path.trim_matches(|character| matches!(character, '"' | '`'));
            let path = path.rsplit_once(':').map_or(path, |(_, suffix)| suffix);
            let segments = path.split('/').filter(|segment| !segment.is_empty()).collect::<Vec<_>>();
            let mut bindings = segments.last().map(|segment| (*segment).to_owned()).into_iter().collect::<Vec<_>>();
            if segments.len() > 1 {
                bindings.push(segments.join("_"));
            }
            bindings
        })
        .any(|binding| used_names.contains(&binding))
}

fn attached_doc_start<D: ast_grep_core::Doc>(node: Node<D>, source: &str) -> Option<usize> {
    let mut previous = node.prev()?;
    let mut next_start = node.range().start;
    let mut next_line = node.start_pos().line();
    let mut start = None;
    loop {
        if !matches!(previous.kind().as_ref(), "comment" | "block_comment")
            || !source[previous.range().end..next_start]
                .lines()
                .all(|line| line.trim().is_empty())
            || previous.end_pos().line() + 1 < next_line
        {
            break;
        }
        start = Some(previous.range().start);
        next_start = previous.range().start;
        next_line = previous.start_pos().line();
        let Some(earlier) = previous.prev() else {
            break;
        };
        previous = earlier;
    }
    start
}

fn has_private_attribute<D: ast_grep_core::Doc>(node: &Node<D>) -> bool {
    node.children()
        .find(|child| child.kind() == "attributes")
        .is_some_and(|attributes| attributes.text().contains("private"))
}

fn clause_blocks<D: ast_grep_core::Doc>(node: Node<D>) -> Vec<Node<D>> {
    node.children()
        .flat_map(|child| {
            if child.kind() == "block" {
                vec![child]
            } else if matches!(child.kind().as_ref(), "else_when_clause" | "else_clause") {
                child
                    .children()
                    .filter(|nested| nested.kind() == "block")
                    .collect()
            } else {
                Vec::new()
            }
        })
        .collect()
}

fn brace_range(range: std::ops::Range<usize>, source: &str) -> Option<std::ops::Range<usize>> {
    let text = &source[range.clone()];
    let start = range.start + text.find('{')?;
    let end = range.start + text.rfind('}')? + 1;
    Some(start..end)
}

fn initializer_after(
    range: std::ops::Range<usize>,
    source: &str,
    separator: &str,
) -> Option<std::ops::Range<usize>> {
    let offset = source[range.clone()].find(separator)?;
    trimmed_range(range.start + offset + separator.len()..range.end, source)
}

fn trimmed_range(mut range: std::ops::Range<usize>, source: &str) -> Option<std::ops::Range<usize>> {
    while range.start < range.end && source.as_bytes()[range.start].is_ascii_whitespace() {
        range.start += 1;
    }
    while range.end > range.start
        && (source.as_bytes()[range.end - 1].is_ascii_whitespace()
            || source.as_bytes()[range.end - 1] == b',')
    {
        range.end -= 1;
    }
    (range.start < range.end).then_some(range)
}

fn field_signature<D: ast_grep_core::Doc>(
    field: Node<D>,
    name: Node<D>,
    source: &str,
) -> String {
    let range = field.range();
    let colon = source[range.clone()]
        .find(':')
        .map_or(name.range().end, |offset| range.start + offset);
    let segment_start = source[range.start..name.range().start]
        .rfind(',')
        .map_or(range.start, |offset| range.start + offset + 1);
    format!(
        "{}{}",
        source[segment_start..name.range().end].trim(),
        source[colon..range.end].trim_end()
    )
}

fn comma_segments(
    body: &std::ops::Range<usize>,
    source: &str,
) -> Vec<(std::ops::Range<usize>, bool)> {
    let bytes = source.as_bytes();
    let mut segments = Vec::new();
    let mut start = body.start + 1;
    let mut depth = 0_usize;
    let mut quote = None;
    let mut index = start;
    while index < body.end.saturating_sub(1) {
        let byte = bytes[index];
        if let Some(delimiter) = quote {
            if byte == b'\\' && delimiter != b'`' {
                index = (index + 2).min(body.end);
                continue;
            }
            if byte == delimiter {
                quote = None;
            }
        } else if matches!(byte, b'"' | b'\'' | b'`') {
            quote = Some(byte);
        } else if byte == b'/' && bytes.get(index + 1) == Some(&b'/') {
            index = source[index..body.end]
                .find('\n')
                .map_or(body.end, |offset| index + offset);
            continue;
        } else if byte == b'/' && bytes.get(index + 1) == Some(&b'*') {
            index = source[index + 2..body.end]
                .find("*/")
                .map_or(body.end, |offset| index + offset + 4);
            continue;
        } else if matches!(byte, b'(' | b'[' | b'{') {
            depth += 1;
        } else if matches!(byte, b')' | b']' | b'}') {
            depth = depth.saturating_sub(1);
        } else if byte == b',' && depth == 0 {
            let mut end = index + 1;
            let line_end = source[end..body.end]
                .find('\n')
                .map_or(body.end, |offset| end + offset);
            if source[end..line_end].trim_start().starts_with("//") {
                end = line_end;
            }
            let mut segment_start = start;
            while segment_start < end && bytes[segment_start].is_ascii_whitespace() {
                segment_start += 1;
            }
            let mut segment_end = end;
            while segment_end > segment_start && bytes[segment_end - 1].is_ascii_whitespace() {
                segment_end -= 1;
            }
            if segment_start < segment_end {
                segments.push((segment_start..segment_end, true));
            }
            start = if end == line_end && line_end < body.end {
                line_end + 1
            } else {
                index + 1
            };
            index = start;
            continue;
        }
        index += 1;
    }
    if let Some(segment) = trimmed_range(start..body.end.saturating_sub(1), source) {
        segments.push((segment, false));
    }
    segments
}

fn qualify(parent: &str, name: &str) -> String {
    if parent.is_empty() {
        name.to_owned()
    } else {
        format!("{parent}.{name}")
    }
}

fn is_declaration(kind: &str) -> bool {
    matches!(
        kind,
        "procedure_declaration"
            | "overloaded_procedure_declaration"
            | "struct_declaration"
            | "enum_declaration"
            | "union_declaration"
            | "bit_field_declaration"
            | "variable_declaration"
            | "var_declaration"
            | "const_declaration"
            | "const_type_declaration"
    )
}
