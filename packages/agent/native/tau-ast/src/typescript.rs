use crate::outline::{
    EntryRole, OutlineEntry, OutlineItem, OutlineMember, OutlineRowKind, ParseCertainty,
    SourcePosition, SourceRange, SymbolType,
};
use ast_grep_core::Node;
use std::collections::BTreeSet;

pub fn extract_typescript_items<D: ast_grep_core::Doc>(
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

    for statement in root.children().filter(|node| node.is_named()) {
        match statement.kind().as_ref() {
            "comment" | "empty_statement" => {}
            "import_statement" => items.push(structural_item(
                statement,
                source,
                OutlineRowKind::Import,
                SymbolType::Module,
                false,
            )),
            "export_statement" => {
                let declaration = statement
                    .field("declaration")
                    .or_else(|| {
                        statement.children().find(|child| {
                            child.is_named()
                                && (is_declaration_kind(child.kind().as_ref())
                                    || child.kind() == "ambient_declaration")
                        })
                    })
                    .and_then(unwrap_ambient);
                if let Some(declaration) = declaration {
                    items.extend(declaration_items(
                        statement,
                        declaration,
                        source,
                        &recovery_ranges,
                        true,
                        include_docs,
                    ));
                } else {
                    items.push(structural_item(
                        statement,
                        source,
                        OutlineRowKind::Export,
                        SymbolType::Module,
                        true,
                    ));
                }
            }
            "ambient_declaration" => {
                if let Some(declaration) = unwrap_ambient(statement.clone()) {
                    items.extend(declaration_items(
                        statement,
                        declaration,
                        source,
                        &recovery_ranges,
                        false,
                        include_docs,
                    ));
                }
            }
            kind if is_declaration_kind(kind) => items.extend(declaration_items(
                statement.clone(),
                statement,
                source,
                &recovery_ranges,
                false,
                include_docs,
            )),
            _ => items.push(structural_item(
                statement,
                source,
                OutlineRowKind::SideEffect,
                SymbolType::Event,
                false,
            )),
        }
    }

    resolve_local_exports(root, &mut items);
    items
}

pub fn filter_typescript_items<D: ast_grep_core::Doc>(
    root: Node<D>,
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

    let mut selected_names = BTreeSet::new();
    let mut selected_ranges = Vec::new();
    for item in items
        .iter_mut()
        .filter(|item| item.row_kind == OutlineRowKind::Declaration)
    {
        let visible = include_private || item.is_exported;
        let item_matches = visible && names.contains(item.entry.name.as_str());
        item.members.retain(|member| {
            visible
                && (include_private || member.is_public)
                && (item_matches || names.contains(member.entry.name.as_str()))
        });
        if item_matches || !item.members.is_empty() {
            selected_names.insert(item.entry.name.clone());
            selected_names.extend(item.members.iter().map(|member| member.entry.name.clone()));
            selected_ranges.push(item.entry.range.clone());
        }
    }

    let used_names = root
        .dfs()
        .filter(|node| {
            matches!(node.kind().as_ref(), "identifier" | "type_identifier")
                && selected_ranges.iter().any(|range| {
                    let node_range = node.range();
                    node_range.start >= range.start_byte && node_range.end <= range.end_byte
                })
        })
        .map(|node| node.text().into_owned())
        .collect::<BTreeSet<_>>();

    items.retain(|item| match item.row_kind {
        OutlineRowKind::Package => false,
        OutlineRowKind::Declaration => selected_ranges.iter().any(|selected| {
            selected.start_byte == item.entry.range.start_byte
                && selected.end_byte == item.entry.range.end_byte
                && (selected_names.contains(&item.entry.name)
                    || item
                        .members
                        .iter()
                        .any(|member| selected_names.contains(&member.entry.name)))
        }),
        OutlineRowKind::Import => root
            .children()
            .find(|node| node.range().start == item.entry.range.start_byte)
            .is_some_and(|node| {
                import_binding_names(node)
                    .iter()
                    .any(|binding| used_names.contains(binding))
            }),
        OutlineRowKind::Export => root
            .children()
            .find(|node| node.range().start == item.entry.range.start_byte)
            .is_some_and(|node| {
                export_names(node)
                    .iter()
                    .any(|name| selected_names.contains(name))
            }),
        OutlineRowKind::SideEffect => false,
    });
}

pub fn finalize_typescript_signatures(items: &mut [OutlineItem]) {
    for item in items {
        if item.row_kind == OutlineRowKind::Declaration
            && matches!(item.entry.symbol_type, SymbolType::Class)
        {
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
}

fn declaration_items<D: ast_grep_core::Doc>(
    outer: Node<D>,
    declaration: Node<D>,
    source: &str,
    recovery_ranges: &[std::ops::Range<usize>],
    is_exported: bool,
    include_docs: bool,
) -> Vec<OutlineItem> {
    if matches!(
        declaration.kind().as_ref(),
        "lexical_declaration" | "variable_declaration"
    ) {
        return declaration
            .children()
            .filter(|child| child.kind() == "variable_declarator")
            .filter_map(|declarator| {
                declaration_item(
                    outer.clone(),
                    declarator,
                    source,
                    recovery_ranges,
                    is_exported,
                    Some(declaration.clone()),
                    include_docs,
                )
            })
            .collect();
    }

    declaration_item(
        outer,
        declaration,
        source,
        recovery_ranges,
        is_exported,
        None,
        include_docs,
    )
    .into_iter()
    .collect()
}

fn declaration_item<D: ast_grep_core::Doc>(
    outer: Node<D>,
    declaration: Node<D>,
    source: &str,
    recovery_ranges: &[std::ops::Range<usize>],
    is_exported: bool,
    lexical_owner: Option<Node<D>>,
    include_docs: bool,
) -> Option<OutlineItem> {
    let name_node = declaration_name(declaration.clone())?;
    let name = name_node.text().into_owned();
    let declaration_kind = lexical_owner.as_ref().map_or_else(
        || declaration.kind().into_owned(),
        |owner| owner.kind().into_owned(),
    );
    let outer_bytes = outer.range();
    let start_byte = attached_start(outer.clone(), source).unwrap_or(outer_bytes.start);
    let declaration_bytes = start_byte..outer_bytes.end;
    let ownership_bytes = lexical_owner
        .as_ref()
        .map_or_else(|| outer.range(), Node::range);
    let body = declaration_body(declaration.clone());
    let body_range = body
        .as_ref()
        .map(|body| source_range(source.as_bytes(), body.range()));
    let signature_end = body
        .as_ref()
        .map_or(declaration_bytes.end, |body| body.range().start);
    let signature = contract_signature(outer, source, signature_end, include_docs);
    let certainty = certainty(recovery_ranges, &declaration_bytes, &ownership_bytes);
    let symbol_type = declaration_symbol_type(
        declaration.kind().as_ref(),
        lexical_owner
            .as_ref()
            .map(|owner| owner.text().into_owned()),
    );
    let members = declaration_members(
        declaration.clone(),
        source,
        recovery_ranges,
        &name,
        include_docs,
    );

    Some(OutlineItem {
        entry: OutlineEntry {
            role: EntryRole::Item,
            symbol_type,
            name: name.clone(),
            qualified_name: name,
            range: source_range(source.as_bytes(), declaration_bytes),
            name_range: source_range(source.as_bytes(), name_node.range()),
            receiver_range: None,
            body_range,
            signature,
            ast_kind: declaration_kind,
            certainty,
            certainty_reason: certainty_reason(certainty),
            locator: None,
        },
        row_kind: OutlineRowKind::Declaration,
        is_import: false,
        is_exported,
        members,
    })
}

fn declaration_members<D: ast_grep_core::Doc>(
    declaration: Node<D>,
    source: &str,
    recovery_ranges: &[std::ops::Range<usize>],
    parent_name: &str,
    include_docs: bool,
) -> Vec<OutlineMember> {
    let Some(body) = declaration.field("body") else {
        return Vec::new();
    };
    let ownership = body.range();
    body.children()
        .filter(|child| child.is_named() && child.kind() != "comment")
        .filter_map(|member| {
            let name_node = declaration_name(member.clone());
            let name = match member.kind().as_ref() {
                "construct_signature" => "new".to_owned(),
                "call_signature" => "call".to_owned(),
                "index_signature" => "index".to_owned(),
                _ => name_node.as_ref()?.text().into_owned(),
            };
            let symbol_type = if name == "constructor" {
                SymbolType::Constructor
            } else {
                member_symbol_type(member.kind().as_ref())?
            };
            let member_bytes = member.range();
            let start_byte = attached_start(member.clone(), source)
                .filter(|start| *start >= ownership.start)
                .unwrap_or(member_bytes.start);
            let declaration_bytes = start_byte..member_bytes.end;
            let implementation = declaration_body(member.clone());
            let body_range = implementation
                .as_ref()
                .map(|body| source_range(source.as_bytes(), body.range()));
            let signature_end = implementation
                .as_ref()
                .map_or(declaration_bytes.end, |body| body.range().start);
            let is_public = member_is_public(member.clone());
            let member_certainty = certainty(recovery_ranges, &declaration_bytes, &ownership);
            Some(OutlineMember {
                entry: OutlineEntry {
                    role: EntryRole::Member,
                    symbol_type,
                    name: name.clone(),
                    qualified_name: format!("{parent_name}.{name}"),
                    range: source_range(source.as_bytes(), declaration_bytes.clone()),
                    name_range: name_node.map_or_else(
                        || source_range(source.as_bytes(), member_bytes.clone()),
                        |name| source_range(source.as_bytes(), name.range()),
                    ),
                    receiver_range: None,
                    body_range,
                    signature: contract_signature(
                        member.clone(),
                        source,
                        signature_end,
                        include_docs,
                    ),
                    ast_kind: member.kind().into_owned(),
                    certainty: member_certainty,
                    certainty_reason: certainty_reason(member_certainty),
                    locator: None,
                },
                is_public,
            })
        })
        .collect()
}

fn structural_item<D: ast_grep_core::Doc>(
    node: Node<D>,
    source: &str,
    row_kind: OutlineRowKind,
    symbol_type: SymbolType,
    is_exported: bool,
) -> OutlineItem {
    let bytes = node.range();
    let signature = source[bytes.clone()].trim().to_owned();
    let name = match row_kind {
        OutlineRowKind::Package => unreachable!("TypeScript has no package clause"),
        OutlineRowKind::Import | OutlineRowKind::Export => node
            .field("source")
            .map(|source| source.text().into_owned())
            .unwrap_or_else(|| {
                if row_kind == OutlineRowKind::Import {
                    "import".to_owned()
                } else {
                    "export".to_owned()
                }
            }),
        OutlineRowKind::SideEffect => side_effect_label(node.clone()),
        OutlineRowKind::Declaration => unreachable!("declarations use declaration_item"),
    };
    let range = source_range(source.as_bytes(), bytes);
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
        is_exported,
        members: Vec::new(),
    }
}

fn unwrap_ambient<D: ast_grep_core::Doc>(node: Node<D>) -> Option<Node<D>> {
    if node.kind() != "ambient_declaration" {
        return Some(node);
    }
    node.children()
        .find(|child| child.is_named() && is_declaration_kind(child.kind().as_ref()))
}

fn is_declaration_kind(kind: &str) -> bool {
    matches!(
        kind,
        "function_declaration"
            | "generator_function_declaration"
            | "function_signature"
            | "class_declaration"
            | "abstract_class_declaration"
            | "interface_declaration"
            | "enum_declaration"
            | "type_alias_declaration"
            | "internal_module"
            | "module"
            | "lexical_declaration"
            | "variable_declaration"
    )
}

fn declaration_name<D: ast_grep_core::Doc>(node: Node<D>) -> Option<Node<D>> {
    if matches!(
        node.kind().as_ref(),
        "identifier" | "property_identifier" | "type_identifier" | "private_property_identifier"
    ) {
        return Some(node);
    }
    node.field("name").or_else(|| {
        node.children().find(|child| {
            child.is_named()
                && matches!(
                    child.kind().as_ref(),
                    "identifier"
                        | "property_identifier"
                        | "type_identifier"
                        | "private_property_identifier"
                )
        })
    })
}

fn declaration_body<D: ast_grep_core::Doc>(node: Node<D>) -> Option<Node<D>> {
    match node.kind().as_ref() {
        "function_declaration"
        | "generator_function_declaration"
        | "method_definition"
        | "class_declaration"
        | "abstract_class_declaration" => node.field("body"),
        "variable_declarator" | "public_field_definition" => {
            node.field("value").and_then(|value| {
                matches!(
                    value.kind().as_ref(),
                    "arrow_function" | "function_expression" | "function"
                )
                .then(|| value.field("body"))
                .flatten()
            })
        }
        _ => None,
    }
}

fn declaration_symbol_type(kind: &str, lexical_source: Option<String>) -> SymbolType {
    match kind {
        "function_declaration" | "generator_function_declaration" | "function_signature" => {
            SymbolType::Function
        }
        "class_declaration" | "abstract_class_declaration" => SymbolType::Class,
        "interface_declaration" => SymbolType::Interface,
        "enum_declaration" => SymbolType::Enum,
        "internal_module" | "module" => SymbolType::Namespace,
        "variable_declarator" => {
            if lexical_source
                .as_deref()
                .is_some_and(|source| source.trim_start().starts_with("const "))
            {
                SymbolType::Constant
            } else {
                SymbolType::Variable
            }
        }
        _ => SymbolType::Struct,
    }
}

fn member_symbol_type(kind: &str) -> Option<SymbolType> {
    match kind {
        "method_definition" => Some(SymbolType::Method),
        "method_signature" | "abstract_method_signature" => Some(SymbolType::Method),
        "construct_signature" => Some(SymbolType::Constructor),
        "call_signature" => Some(SymbolType::Function),
        "public_field_definition" | "property_signature" | "index_signature" => {
            Some(SymbolType::Property)
        }
        "enum_assignment" | "property_identifier" => Some(SymbolType::EnumMember),
        _ => None,
    }
}

fn member_is_public<D: ast_grep_core::Doc>(node: Node<D>) -> bool {
    let name_is_private = declaration_name(node.clone())
        .is_some_and(|name| name.kind() == "private_property_identifier");
    !name_is_private
        && !node.dfs().any(|child| {
            child.kind() == "accessibility_modifier"
                && matches!(child.text().as_ref(), "private" | "protected")
        })
}

fn resolve_local_exports<D: ast_grep_core::Doc>(root: Node<D>, items: &mut [OutlineItem]) {
    let exported = root
        .children()
        .filter(|node| node.kind() == "export_statement" && node.field("source").is_none())
        .flat_map(export_names)
        .collect::<BTreeSet<_>>();
    for item in items
        .iter_mut()
        .filter(|item| item.row_kind == OutlineRowKind::Declaration)
    {
        if exported.contains(&item.entry.name) {
            item.is_exported = true;
        }
    }
}

fn export_names<D: ast_grep_core::Doc>(node: Node<D>) -> Vec<String> {
    node.dfs()
        .filter(|child| child.kind() == "export_specifier")
        .filter_map(|specifier| specifier.field("name"))
        .map(|name| name.text().into_owned())
        .collect()
}

fn import_binding_names<D: ast_grep_core::Doc>(node: Node<D>) -> BTreeSet<String> {
    node.dfs()
        .filter_map(|child| match child.kind().as_ref() {
            "import_specifier" => child
                .field("alias")
                .or_else(|| child.field("name"))
                .map(|name| name.text().into_owned()),
            "identifier"
                if child.parent().is_some_and(|parent| {
                    matches!(parent.kind().as_ref(), "import_clause" | "namespace_import")
                }) =>
            {
                Some(child.text().into_owned())
            }
            _ => None,
        })
        .collect()
}

fn side_effect_label<D: ast_grep_core::Doc>(node: Node<D>) -> String {
    let call = node
        .dfs()
        .find(|candidate| candidate.kind() == "call_expression");
    if let Some(call) = call
        && let Some(function) = call.field("function")
    {
        return format!("call {}(...)", function.text());
    }
    node.kind().replace('_', " ")
}

fn certainty(
    recovery_ranges: &[std::ops::Range<usize>],
    declaration: &std::ops::Range<usize>,
    ownership: &std::ops::Range<usize>,
) -> ParseCertainty {
    if recovery_ranges
        .iter()
        .any(|recovery| intersects(recovery, declaration) || intersects(recovery, ownership))
    {
        ParseCertainty::Recovered
    } else if recovery_ranges
        .iter()
        .any(|recovery| recovery.end == ownership.start || recovery.start == ownership.end)
    {
        ParseCertainty::NearRecovery
    } else {
        ParseCertainty::Certain
    }
}

fn certainty_reason(certainty: ParseCertainty) -> Option<String> {
    match certainty {
        ParseCertainty::Certain => None,
        ParseCertainty::Recovered => {
            Some("parser recovery intersects the declaration or its owning structure".to_owned())
        }
        ParseCertainty::NearRecovery => {
            Some("parser recovery is adjacent to the declaration's owning structure".to_owned())
        }
    }
}

fn attached_start<D: ast_grep_core::Doc>(node: Node<D>, source: &str) -> Option<usize> {
    attached_nodes(node, source)
        .first()
        .map(|attached| attached.range().start)
}

fn attached_nodes<'tree, D: ast_grep_core::Doc>(
    node: Node<'tree, D>,
    source: &str,
) -> Vec<Node<'tree, D>> {
    let mut previous = node.prev();
    let mut next_line = node.start_pos().line();
    let mut next_start = node.range().start;
    let mut attachments = Vec::new();
    while let Some(attached) = previous {
        let is_doc = attached.kind() == "comment" && attached.text().starts_with("/**");
        if (!is_doc && attached.kind() != "decorator")
            || attached.end_pos().line() + 1 < next_line
            || !source[attached.range().end..next_start]
                .lines()
                .all(|line| line.trim().is_empty())
        {
            break;
        }
        attachments.push(attached.clone());
        next_line = attached.start_pos().line();
        next_start = attached.range().start;
        previous = attached.prev();
    }
    attachments.reverse();
    attachments
}

fn source_range(source: &[u8], bytes: std::ops::Range<usize>) -> SourceRange {
    SourceRange {
        start_byte: bytes.start,
        end_byte: bytes.end,
        start: position(source, bytes.start),
        end: position(source, bytes.end),
    }
}

fn position(source: &[u8], byte: usize) -> SourcePosition {
    let prefix = &source[..byte];
    let line = prefix
        .iter()
        .filter(|candidate| **candidate == b'\n')
        .count();
    let column = prefix
        .iter()
        .rposition(|candidate| *candidate == b'\n')
        .map_or(prefix.len(), |newline| prefix.len() - newline - 1);
    SourcePosition { line, column }
}

fn intersects(left: &std::ops::Range<usize>, right: &std::ops::Range<usize>) -> bool {
    left.start < right.end && right.start < left.end
}

fn indent(source: &str) -> String {
    source
        .lines()
        .map(|line| format!("  {line}"))
        .collect::<Vec<_>>()
        .join("\n")
}

fn contract_signature<D: ast_grep_core::Doc>(
    node: Node<D>,
    source: &str,
    end_byte: usize,
    include_docs: bool,
) -> String {
    let attachments = attached_nodes(node.clone(), source);
    let signature = if include_docs {
        let start = attachments
            .first()
            .map_or(node.range().start, |attached| attached.range().start);
        source[start..end_byte].trim_end().to_owned()
    } else {
        let decorators = attachments
            .iter()
            .filter(|attached| attached.kind() == "decorator")
            .map(|decorator| decorator.text().trim().to_owned())
            .collect::<Vec<_>>()
            .join("\n");
        let declaration = source[node.range().start..end_byte].trim_end();
        if decorators.is_empty() {
            declaration.to_owned()
        } else {
            format!("{decorators}\n{declaration}")
        }
    };
    if signature.ends_with("=>") {
        format!("{signature} …")
    } else {
        signature
    }
}
