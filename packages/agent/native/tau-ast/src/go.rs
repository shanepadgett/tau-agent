use crate::outline::{
    EntryRole, OutlineEntry, OutlineItem, OutlineMember, OutlineRowKind, ParseCertainty,
    SourceRange, SymbolType,
};
use crate::source::{certainty, certainty_reason, indent, source_range};
use ast_grep_core::Node;
use std::collections::BTreeSet;

pub fn extract_go_items<D: ast_grep_core::Doc>(
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
            "comment" => {}
            "package_clause" => items.push(structural_item(
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
            "const_declaration" => items.extend(spec_items(
                node,
                source,
                &recovery_ranges,
                "const_spec",
                SymbolType::Constant,
                "const",
                include_docs,
            )),
            "var_declaration" => items.extend(spec_items(
                node,
                source,
                &recovery_ranges,
                "var_spec",
                SymbolType::Variable,
                "var",
                include_docs,
            )),
            "type_declaration" => {
                items.extend(type_items(node, source, &recovery_ranges, include_docs))
            }
            "function_declaration" => {
                if let Some(item) =
                    callable_item(node, source, &recovery_ranges, false, include_docs)
                {
                    items.push(item);
                }
            }
            "method_declaration" => {
                if let Some(item) =
                    callable_item(node, source, &recovery_ranges, true, include_docs)
                {
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

pub fn filter_go_items<D: ast_grep_core::Doc>(
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
            include_private || item.is_exported || item.entry.name == "init"
        });
        return;
    }

    let mut selected_ranges = Vec::new();
    items.retain_mut(|item| match item.row_kind {
        OutlineRowKind::Package => true,
        OutlineRowKind::Import => false,
        OutlineRowKind::Export | OutlineRowKind::SideEffect => false,
        OutlineRowKind::Declaration => {
            let visible = include_private || item.is_exported || item.entry.name == "init";
            let receiver_matches = item
                .entry
                .qualified_name
                .split_once('.')
                .is_some_and(|(receiver, _)| names.contains(receiver));
            let item_matches = visible
                && (names.contains(item.entry.name.as_str())
                    || names.contains(item.entry.qualified_name.as_str())
                    || receiver_matches);
            item.members.retain(|member| {
                visible
                    && (include_private || member.is_public)
                    && (item_matches
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

    let used_qualifiers = used_go_qualifiers(root.clone(), &selected_ranges);
    let import_starts = root
        .children()
        .filter(|node| node.kind() == "import_declaration")
        .filter(|node| import_is_used(node.clone(), &used_qualifiers))
        .map(|node| node.range().start)
        .collect::<BTreeSet<_>>();
    for node in root.children().filter(|node| {
        node.kind() == "import_declaration" && import_starts.contains(&node.range().start)
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

pub fn finalize_go_signatures(items: &mut [OutlineItem]) {
    for item in items {
        if item.row_kind != OutlineRowKind::Declaration
            || !matches!(
                item.entry.symbol_type,
                SymbolType::Struct | SymbolType::Interface
            )
            || item.entry.body_range.is_none()
        {
            continue;
        }
        let header = item.entry.signature.trim_end();
        item.entry.signature = if item.members.is_empty() {
            format!("{header} {{}}")
        } else {
            let members = item
                .members
                .iter()
                .map(|member| indent(&member.entry.signature))
                .collect::<Vec<_>>()
                .join("\n");
            format!("{header} {{\n{members}\n}}")
        };
    }
}

pub fn matching_go_imports<'a, D: ast_grep_core::Doc>(
    root: Node<D>,
    source: &'a str,
    declaration: &SourceRange,
) -> Vec<&'a str> {
    let qualifiers = used_go_qualifiers(root.clone(), std::slice::from_ref(declaration));
    root.children()
        .filter(|node| node.kind() == "import_declaration")
        .filter(|node| import_is_used(node.clone(), &qualifiers))
        .map(|node| {
            let range = node.range();
            &source[range.start..range.end]
        })
        .collect()
}

fn type_items<D: ast_grep_core::Doc>(
    outer: Node<D>,
    source: &str,
    recovery_ranges: &[std::ops::Range<usize>],
    include_docs: bool,
) -> Vec<OutlineItem> {
    immediate_specs(outer.clone(), &["type_spec", "type_alias"])
        .into_iter()
        .enumerate()
        .filter_map(|(index, spec)| {
            let name_node = spec.field("name")?;
            let name = name_node.text().into_owned();
            let type_node = spec.field("type");
            let symbol_type = match type_node
                .as_ref()
                .map(|node| node.kind().into_owned())
                .as_deref()
            {
                Some("struct_type") => SymbolType::Struct,
                Some("interface_type") => SymbolType::Interface,
                _ => SymbolType::Struct,
            };
            let outer_range = outer.range();
            let start_byte = attached_doc_start(outer.clone(), source).unwrap_or(outer_range.start);
            let declaration_range = start_byte..outer_range.end;
            let body_bytes = type_node.as_ref().and_then(type_body_bytes);
            let signature = if let Some(body_bytes) = &body_bytes {
                let spec_start = spec.range().start;
                let signature = format!("type {}", source[spec_start..body_bytes.start].trim_end());
                let spec_has_docs = attached_doc_start(spec.clone(), source)
                    .is_some_and(|start| start >= outer_range.start);
                if spec_has_docs {
                    with_attached_comments(source, spec.clone(), signature, include_docs)
                } else if index == 0 {
                    with_attached_comments(source, outer.clone(), signature, include_docs)
                } else {
                    signature
                }
            } else {
                let signature = format!("type {}", spec.text().trim());
                let spec_has_docs = attached_doc_start(spec.clone(), source)
                    .is_some_and(|start| start >= outer_range.start);
                if spec_has_docs {
                    with_attached_comments(source, spec.clone(), signature, include_docs)
                } else if index == 0 {
                    with_attached_comments(source, outer.clone(), signature, include_docs)
                } else {
                    signature
                }
            };
            let certainty = certainty(recovery_ranges, &declaration_range, &outer_range);
            Some(OutlineItem {
                entry: OutlineEntry {
                    role: EntryRole::Item,
                    symbol_type,
                    name: name.clone(),
                    qualified_name: name.clone(),
                    range: source_range(source.as_bytes(), declaration_range),
                    name_range: source_range(source.as_bytes(), name_node.range()),
                    receiver_range: None,
                    body_range: body_bytes.map(|bytes| source_range(source.as_bytes(), bytes)),
                    signature,
                    ast_kind: spec.kind().into_owned(),
                    certainty,
                    certainty_reason: certainty_reason(certainty),
                    locator: None,
                },
                row_kind: OutlineRowKind::Declaration,
                is_import: false,
                is_exported: is_exported(&name),
                members: type_node.map_or_else(Vec::new, |node| {
                    type_members(node, source, recovery_ranges, &name, include_docs)
                }),
            })
        })
        .collect()
}

fn spec_items<D: ast_grep_core::Doc>(
    outer: Node<D>,
    source: &str,
    recovery_ranges: &[std::ops::Range<usize>],
    spec_kind: &str,
    symbol_type: SymbolType,
    keyword: &str,
    include_docs: bool,
) -> Vec<OutlineItem> {
    immediate_specs(outer.clone(), &[spec_kind])
        .into_iter()
        .enumerate()
        .flat_map(|(index, spec)| {
            let names = spec
                .children()
                .filter(|child| child.kind() == "identifier")
                .collect::<Vec<_>>();
            names.into_iter().map({
                let outer = outer.clone();
                let spec = spec.clone();
                move |name_node| (outer.clone(), spec.clone(), name_node, index)
            })
        })
        .map(|(outer, spec, name_node, index)| {
            let name = name_node.text().into_owned();
            let outer_range = outer.range();
            let start_byte = attached_doc_start(outer.clone(), source).unwrap_or(outer_range.start);
            let declaration_range = start_byte..outer_range.end;
            let certainty = certainty(recovery_ranges, &declaration_range, &outer_range);
            let (spec_signature, body_range) = spec_signature(keyword, spec.clone(), source);
            OutlineItem {
                entry: OutlineEntry {
                    role: EntryRole::Item,
                    symbol_type,
                    name: name.clone(),
                    qualified_name: name.clone(),
                    range: source_range(source.as_bytes(), declaration_range),
                    name_range: source_range(source.as_bytes(), name_node.range()),
                    receiver_range: None,
                    body_range: body_range.map(|bytes| source_range(source.as_bytes(), bytes)),
                    signature: {
                        let spec_has_docs = attached_doc_start(spec.clone(), source)
                            .is_some_and(|start| start >= outer_range.start);
                        if spec_has_docs {
                            with_attached_comments(
                                source,
                                spec.clone(),
                                spec_signature,
                                include_docs,
                            )
                        } else if index == 0 {
                            with_attached_comments(source, outer, spec_signature, include_docs)
                        } else {
                            spec_signature
                        }
                    },
                    ast_kind: spec.kind().into_owned(),
                    certainty,
                    certainty_reason: certainty_reason(certainty),
                    locator: None,
                },
                row_kind: OutlineRowKind::Declaration,
                is_import: false,
                is_exported: is_exported(&name),
                members: Vec::new(),
            }
        })
        .collect()
}

fn callable_item<D: ast_grep_core::Doc>(
    node: Node<D>,
    source: &str,
    recovery_ranges: &[std::ops::Range<usize>],
    is_method: bool,
    include_docs: bool,
) -> Option<OutlineItem> {
    let name_node = node.field("name")?;
    let name = name_node.text().into_owned();
    let node_range = node.range();
    let start_byte = attached_doc_start(node.clone(), source).unwrap_or(node_range.start);
    let declaration_range = start_byte..node_range.end;
    let body = node.field("body");
    let signature_end = body
        .as_ref()
        .map_or(node_range.end, |body| body.range().start);
    let receiver = is_method.then(|| node.field("receiver")).flatten();
    let receiver_name = receiver.as_ref().and_then(receiver_type_name);
    let qualified_name = receiver_name
        .as_ref()
        .map_or_else(|| name.clone(), |receiver| format!("{receiver}.{name}"));
    let certainty = certainty(recovery_ranges, &declaration_range, &node_range);
    Some(OutlineItem {
        entry: OutlineEntry {
            role: if is_method {
                EntryRole::Member
            } else {
                EntryRole::Item
            },
            symbol_type: if is_method {
                SymbolType::Method
            } else {
                SymbolType::Function
            },
            name: name.clone(),
            qualified_name,
            range: source_range(source.as_bytes(), declaration_range),
            name_range: source_range(source.as_bytes(), name_node.range()),
            receiver_range: receiver
                .as_ref()
                .map(|receiver| source_range(source.as_bytes(), receiver.range())),
            body_range: body
                .as_ref()
                .map(|body| source_range(source.as_bytes(), body.range())),
            signature: with_attached_comments(
                source,
                node.clone(),
                source[node_range.start..signature_end]
                    .trim_end()
                    .to_owned(),
                include_docs,
            ),
            ast_kind: node.kind().into_owned(),
            certainty,
            certainty_reason: certainty_reason(certainty),
            locator: None,
        },
        row_kind: OutlineRowKind::Declaration,
        is_import: false,
        is_exported: is_exported(&name),
        members: Vec::new(),
    })
}

fn type_members<D: ast_grep_core::Doc>(
    type_node: Node<D>,
    source: &str,
    recovery_ranges: &[std::ops::Range<usize>],
    parent_name: &str,
    include_docs: bool,
) -> Vec<OutlineMember> {
    let Some(body) = type_body_node(&type_node) else {
        return Vec::new();
    };
    let ownership = body.range();
    body.children()
        .filter(|node| {
            matches!(
                node.kind().as_ref(),
                "field_declaration" | "method_elem" | "type_elem"
            )
        })
        .flat_map(|member| {
            let names = member_names(member.clone());
            names.into_iter().map({
                let member = member.clone();
                move |(name, name_node)| (member.clone(), name, name_node)
            })
        })
        .map(|(member, name, name_node)| {
            let member_range = member.range();
            let start_byte = attached_doc_start(member.clone(), source)
                .filter(|start| *start >= ownership.start)
                .unwrap_or(member_range.start);
            let declaration_range = start_byte..member_range.end;
            let member_certainty = certainty(recovery_ranges, &declaration_range, &ownership);
            let member_kind = member.kind();
            let symbol_type = match member_kind.as_ref() {
                "method_elem" => SymbolType::Method,
                "type_elem" => SymbolType::TypeParameter,
                _ => SymbolType::Field,
            };
            let signature = if member_kind == "field_declaration" {
                with_attached_comments(
                    source,
                    member.clone(),
                    field_signature(member.clone(), &name, source, member_range.start),
                    include_docs,
                )
            } else {
                with_attached_comments(
                    source,
                    member.clone(),
                    source[member_range.clone()].trim().to_owned(),
                    include_docs,
                )
            };
            OutlineMember {
                entry: OutlineEntry {
                    role: EntryRole::Member,
                    symbol_type,
                    name: name.clone(),
                    qualified_name: format!("{parent_name}.{name}"),
                    range: source_range(source.as_bytes(), declaration_range),
                    name_range: source_range(source.as_bytes(), name_node.range()),
                    receiver_range: None,
                    body_range: None,
                    signature,
                    ast_kind: member_kind.into_owned(),
                    certainty: member_certainty,
                    certainty_reason: certainty_reason(member_certainty),
                    locator: None,
                },
                is_public: member.kind() == "type_elem" || is_exported(&name),
            }
        })
        .collect()
}

fn member_names<D: ast_grep_core::Doc>(node: Node<D>) -> Vec<(String, Node<D>)> {
    if node.kind() == "type_elem" {
        let text = node.text().trim().to_owned();
        if text.contains('|') || text.contains('~') {
            return vec![(text, node)];
        }
    }
    let explicit = node
        .children()
        .filter(|child| matches!(child.kind().as_ref(), "field_identifier" | "identifier"))
        .map(|child| (child.text().into_owned(), child))
        .collect::<Vec<_>>();
    if !explicit.is_empty() {
        return explicit;
    }
    let fallback = node
        .dfs()
        .find(|child| {
            matches!(
                child.kind().as_ref(),
                "type_identifier" | "field_identifier"
            )
        })
        .or_else(|| node.children().find(|child| child.is_named()));
    fallback
        .map(|name| vec![(name.text().trim().to_owned(), name)])
        .unwrap_or_default()
}

fn type_body_node<'tree, D: ast_grep_core::Doc>(node: &Node<'tree, D>) -> Option<Node<'tree, D>> {
    if node.kind() == "field_declaration_list" {
        return Some(node.clone());
    }
    node.children()
        .find(|child| child.kind() == "field_declaration_list")
        .or_else(|| {
            matches!(node.kind().as_ref(), "interface_type" | "struct_type").then(|| node.clone())
        })
}

fn type_body_bytes<D: ast_grep_core::Doc>(node: &Node<D>) -> Option<std::ops::Range<usize>> {
    if let Some(fields) = node
        .children()
        .find(|child| child.kind() == "field_declaration_list")
    {
        return Some(fields.range());
    }
    let start = node
        .children()
        .find(|child| child.kind() == "{")?
        .range()
        .start;
    let end = node
        .children()
        .filter(|child| child.kind() == "}")
        .last()?
        .range()
        .end;
    Some(start..end)
}

fn field_signature<D: ast_grep_core::Doc>(
    member: Node<D>,
    name: &str,
    source: &str,
    start_byte: usize,
) -> String {
    let names = member
        .children()
        .filter(|child| child.kind() == "field_identifier")
        .collect::<Vec<_>>();
    let Some(last_name) = names.last() else {
        return source[start_byte..member.range().end].trim().to_owned();
    };
    let suffix = source[last_name.range().end..member.range().end].trim_start();
    let docs = source[start_byte..member.range().start].trim_end();
    if docs.is_empty() {
        format!("{name} {suffix}")
    } else {
        format!("{docs}\n{name} {suffix}")
    }
}

fn spec_signature<D: ast_grep_core::Doc>(
    keyword: &str,
    spec: Node<D>,
    source: &str,
) -> (String, Option<std::ops::Range<usize>>) {
    let mut function_bodies = spec
        .dfs()
        .filter(|node| node.kind() == "func_literal")
        .filter_map(|function| function.field("body").map(|body| body.range()))
        .collect::<Vec<_>>();
    function_bodies.sort_by_key(|body| body.start);
    if !function_bodies.is_empty() {
        let spec_range = spec.range();
        let mut signature = format!("{keyword} ");
        let mut cursor = spec_range.start;
        for body in &function_bodies {
            signature.push_str(&source[cursor..body.start]);
            signature.push_str("{ … }");
            cursor = body.end;
        }
        signature.push_str(&source[cursor..spec_range.end]);
        let body_range = (function_bodies.len() == 1).then(|| function_bodies[0].clone());
        return (signature.trim().to_owned(), body_range);
    }
    let mut signature = format!("{keyword} {}", spec.text().trim());
    if keyword == "const" && spec.field("type").is_none() && spec.field("value").is_none() {
        signature.push_str(" = … // inherited");
    }
    (signature, None)
}

fn immediate_specs<'tree, D: ast_grep_core::Doc>(
    outer: Node<'tree, D>,
    kinds: &[&str],
) -> Vec<Node<'tree, D>> {
    outer
        .children()
        .flat_map(|child| {
            if kinds.contains(&child.kind().as_ref()) {
                vec![child]
            } else {
                child
                    .children()
                    .filter(|nested| kinds.contains(&nested.kind().as_ref()))
                    .collect()
            }
        })
        .collect()
}

fn receiver_type_name<D: ast_grep_core::Doc>(receiver: &Node<D>) -> Option<String> {
    receiver
        .dfs()
        .find(|node| node.kind() == "type_identifier")
        .map(|node| node.text().into_owned())
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
    let package_name = (row_kind == OutlineRowKind::Package)
        .then(|| {
            node.children()
                .find(|child| child.kind() == "package_identifier")
        })
        .flatten();
    let name = if let Some(package_name) = &package_name {
        package_name.text().into_owned()
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
            name_range: package_name
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

fn used_go_qualifiers<D: ast_grep_core::Doc>(
    root: Node<D>,
    ranges: &[SourceRange],
) -> BTreeSet<String> {
    root.dfs()
        .filter(|node| {
            node.kind() == "selector_expression"
                || matches!(
                    node.kind().as_ref(),
                    "qualified_type" | "qualified_type_name"
                )
        })
        .filter(|node| {
            let bytes = node.range();
            ranges
                .iter()
                .any(|range| bytes.start >= range.start_byte && bytes.end <= range.end_byte)
        })
        .filter_map(|node| {
            node.field("operand")
                .or_else(|| node.field("package"))
                .or_else(|| {
                    node.children().find(|child| {
                        matches!(child.kind().as_ref(), "identifier" | "package_identifier")
                    })
                })
        })
        .map(|node| node.text().into_owned())
        .collect()
}

fn import_is_used<D: ast_grep_core::Doc>(
    declaration: Node<D>,
    used_qualifiers: &BTreeSet<String>,
) -> bool {
    declaration
        .dfs()
        .filter(|node| node.kind() == "import_spec")
        .any(|spec| {
            let alias = spec.field("name").map(|node| node.text().into_owned());
            if alias
                .as_deref()
                .is_some_and(|alias| matches!(alias, "." | "_"))
            {
                return true;
            }
            alias.is_none_or(|binding| used_qualifiers.contains(&binding))
        })
}

fn attached_doc_start<D: ast_grep_core::Doc>(node: Node<D>, source: &str) -> Option<usize> {
    attached_comments(node, source)
        .first()
        .map(|comment| comment.range().start)
}

fn attached_comments<'tree, D: ast_grep_core::Doc>(
    node: Node<'tree, D>,
    source: &str,
) -> Vec<Node<'tree, D>> {
    let mut previous = node.prev();
    let mut next_line = node.start_pos().line();
    let mut comments = Vec::new();
    while let Some(comment) = previous {
        let line_start = source[..comment.range().start]
            .rfind('\n')
            .map_or(0, |newline| newline + 1);
        if comment.kind() != "comment"
            || comment.end_pos().line() + 1 < next_line
            || !source[line_start..comment.range().start].trim().is_empty()
        {
            break;
        }
        comments.push(comment.clone());
        next_line = comment.start_pos().line();
        previous = comment.prev();
    }
    comments.reverse();
    comments
}

fn with_attached_comments<D: ast_grep_core::Doc>(
    source: &str,
    node: Node<D>,
    signature: String,
    include_docs: bool,
) -> String {
    let comments = attached_comments(node.clone(), source);
    let Some(first) = comments.first() else {
        return signature;
    };
    let retained = if include_docs {
        source[first.range().start..node.range().start]
            .trim_end()
            .to_owned()
    } else {
        comments
            .iter()
            .filter(|comment| {
                let comment = comment.text();
                let comment = comment.trim_start();
                comment.starts_with("//go:")
                    || comment.starts_with("//line ")
                    || comment.starts_with("//export ")
                    || comment.starts_with("// +build ")
                    || comment.starts_with("/*line ")
            })
            .map(|comment| comment.text().trim().to_owned())
            .collect::<Vec<String>>()
            .join("\n")
    };
    if retained.is_empty() {
        signature
    } else {
        format!("{retained}\n{signature}")
    }
}

fn is_exported(name: &str) -> bool {
    name.chars().next().is_some_and(char::is_uppercase)
}
