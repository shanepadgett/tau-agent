use crate::{
    outline::{EntryRole, OutlineEntry, OutlineItem, OutlineRowKind, ParseDiagnostics, SymbolType},
    source::{certainty, certainty_reason, source_range},
};
use std::collections::BTreeSet;
use tree_sitter::Node;

struct Heading {
    level: usize,
    start_byte: usize,
    end_byte: usize,
    name_start_byte: usize,
    name_end_byte: usize,
    name: String,
    signature: String,
    ast_kind: String,
}

pub fn extract_markdown_items(root: Node<'_>, source: &str) -> Vec<OutlineItem> {
    let mut headings = Vec::new();
    collect_headings(root, source, &mut headings);
    let recovery_ranges = recovery_ranges(root);
    let mut ancestors = Vec::<(usize, String)>::new();

    headings
        .iter()
        .enumerate()
        .map(|(index, heading)| {
            while ancestors
                .last()
                .is_some_and(|(level, _)| *level >= heading.level)
            {
                ancestors.pop();
            }
            let end_byte = headings[index + 1..]
                .iter()
                .find(|later| later.level <= heading.level)
                .map_or(source.len(), |later| later.start_byte);
            let mut qualified_parts = ancestors
                .iter()
                .map(|(_, name)| name.as_str())
                .collect::<Vec<_>>();
            qualified_parts.push(&heading.name);
            let qualified_name = qualified_parts.join(".");
            ancestors.push((heading.level, heading.name.clone()));
            let declaration_bytes = heading.start_byte..end_byte;
            let certainty = certainty(&recovery_ranges, &declaration_bytes, &declaration_bytes);

            OutlineItem {
                entry: OutlineEntry {
                    role: EntryRole::Item,
                    symbol_type: SymbolType::Heading,
                    name: heading.name.clone(),
                    qualified_name,
                    range: source_range(source.as_bytes(), declaration_bytes),
                    name_range: source_range(
                        source.as_bytes(),
                        heading.name_start_byte..heading.name_end_byte,
                    ),
                    receiver_range: None,
                    body_range: Some(source_range(source.as_bytes(), heading.end_byte..end_byte)),
                    signature: heading.signature.clone(),
                    ast_kind: heading.ast_kind.clone(),
                    certainty,
                    certainty_reason: certainty_reason(certainty),
                    locator: None,
                },
                row_kind: OutlineRowKind::Declaration,
                is_import: false,
                is_exported: true,
                members: Vec::new(),
            }
        })
        .collect()
}

pub fn filter_markdown_items(items: &mut Vec<OutlineItem>, names: &[String]) {
    let names = names.iter().map(String::as_str).collect::<BTreeSet<_>>();
    if names.is_empty() {
        return;
    }
    items.retain(|item| {
        names.contains(item.entry.name.as_str())
            || names.contains(item.entry.qualified_name.as_str())
    });
}

pub fn validate_markdown_source(source: &str) -> Result<(), &'static str> {
    let mut fence = None::<(u8, usize, usize)>;
    for line in source.lines() {
        let bytes = line.as_bytes();
        if let Some((marker, length, container_depth)) = fence {
            let (_, content) = strip_block_containers(bytes, container_depth);
            if closes_fence(content, marker, length) {
                fence = None;
            }
            continue;
        }
        if bytes
            .iter()
            .take_while(|byte| matches!(byte, b' ' | b'\t'))
            .count()
            > 256
        {
            return Err("Markdown block container nesting exceeds the supported limit");
        }
        let (depth, content) = strip_block_containers(bytes, usize::MAX);
        if depth > 128 {
            return Err("Markdown block container nesting exceeds the supported limit");
        }
        if let Some((marker, length)) = opens_fence(content) {
            fence = Some((marker, length, depth));
        }
    }
    Ok(())
}

pub fn markdown_diagnostics(root: Node<'_>) -> ParseDiagnostics {
    let mut diagnostics = ParseDiagnostics {
        error_nodes: 0,
        missing_nodes: 0,
    };
    visit(root, &mut |node| {
        diagnostics.error_nodes += usize::from(node.is_error());
        diagnostics.missing_nodes += usize::from(node.is_missing());
    });
    diagnostics
}

fn collect_headings(node: Node<'_>, source: &str, headings: &mut Vec<Heading>) {
    if matches!(node.kind(), "atx_heading" | "setext_heading") {
        let mut ancestor = node.parent();
        let mut excluded = false;
        while let Some(parent) = ancestor {
            if matches!(parent.kind(), "block_quote" | "list_item") {
                excluded = true;
                break;
            }
            ancestor = parent.parent();
        }
        if excluded {
            return;
        }
        let heading_bytes = node.byte_range();
        let name_node = node.child_by_field_name("heading_content");
        let name_bytes = name_node.map_or(heading_bytes.start..heading_bytes.start, |name| {
            name.byte_range()
        });
        let raw_name = &source[name_bytes.clone()];
        let relative_start = raw_name
            .as_bytes()
            .iter()
            .take_while(|byte| byte.is_ascii_whitespace())
            .count();
        let mut relative_end = raw_name
            .as_bytes()
            .iter()
            .rposition(|byte| !byte.is_ascii_whitespace())
            .map_or(relative_start, |index| index + 1);
        if node.kind() == "atx_heading" {
            let hash_start = raw_name.as_bytes()[relative_start..relative_end]
                .iter()
                .rposition(|byte| *byte != b'#')
                .map_or(relative_start, |index| relative_start + index + 1);
            if hash_start < relative_end
                && (hash_start == relative_start
                    || matches!(raw_name.as_bytes()[hash_start - 1], b' ' | b'\t'))
            {
                relative_end = hash_start;
                while relative_end > relative_start
                    && matches!(raw_name.as_bytes()[relative_end - 1], b' ' | b'\t')
                {
                    relative_end -= 1;
                }
            }
        }
        let trimmed_start = name_bytes.start + relative_start;
        let trimmed_end = name_bytes.start + relative_end;
        let trimmed_name = &source[trimmed_start..trimmed_end];
        let name = if trimmed_name.is_empty() {
            "?".to_owned()
        } else if node.kind() == "setext_heading" {
            trimmed_name
                .split_ascii_whitespace()
                .collect::<Vec<_>>()
                .join(" ")
        } else {
            trimmed_name.to_owned()
        };
        let level = if node.kind() == "atx_heading" {
            let mut cursor = node.walk();
            node.children(&mut cursor)
                .find_map(|child| match child.kind() {
                    "atx_h1_marker" => Some(1),
                    "atx_h2_marker" => Some(2),
                    "atx_h3_marker" => Some(3),
                    "atx_h4_marker" => Some(4),
                    "atx_h5_marker" => Some(5),
                    "atx_h6_marker" => Some(6),
                    _ => None,
                })
                .unwrap_or(1)
        } else {
            let mut cursor = node.walk();
            if node
                .children(&mut cursor)
                .any(|child| child.kind() == "setext_h1_underline")
            {
                1
            } else {
                2
            }
        };
        headings.push(Heading {
            level,
            start_byte: heading_bytes.start,
            end_byte: heading_bytes.end,
            name_start_byte: trimmed_start,
            name_end_byte: trimmed_end,
            name,
            signature: source[heading_bytes].trim_end().to_owned(),
            ast_kind: node.kind().to_owned(),
        });
        return;
    }

    let mut cursor = node.walk();
    for child in node.named_children(&mut cursor) {
        collect_headings(child, source, headings);
    }
}

fn recovery_ranges(root: Node<'_>) -> Vec<std::ops::Range<usize>> {
    let mut ranges = Vec::new();
    visit(root, &mut |node| {
        if node.is_error() || node.is_missing() {
            ranges.push(node.byte_range());
        }
    });
    ranges
}

fn visit(node: Node<'_>, callback: &mut impl FnMut(Node<'_>)) {
    callback(node);
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        visit(child, callback);
    }
}

fn strip_block_containers(mut line: &[u8], maximum: usize) -> (usize, &[u8]) {
    let mut depth = 0;
    while depth < maximum {
        let spaces = line.iter().take_while(|byte| **byte == b' ').count();
        if spaces > 3 {
            break;
        }
        line = &line[spaces..];
        let marker_length = if line.first() == Some(&b'>')
            || (line.len() >= 2
                && matches!(line[0], b'-' | b'+' | b'*')
                && matches!(line[1], b' ' | b'\t'))
        {
            1
        } else {
            let digits = line
                .iter()
                .take(9)
                .take_while(|byte| byte.is_ascii_digit())
                .count();
            if digits > 0
                && matches!(line.get(digits), Some(b'.' | b')'))
                && matches!(line.get(digits + 1), Some(b' ' | b'\t'))
            {
                digits + 1
            } else {
                break;
            }
        };
        line = &line[marker_length..];
        if matches!(line.first(), Some(b' ' | b'\t')) {
            line = &line[1..];
        }
        depth += 1;
    }
    (depth, line)
}

fn opens_fence(line: &[u8]) -> Option<(u8, usize)> {
    let spaces = line.iter().take_while(|byte| **byte == b' ').count();
    if spaces > 3 {
        return None;
    }
    let marker = *line.get(spaces)?;
    if !matches!(marker, b'`' | b'~') {
        return None;
    }
    let length = line[spaces..]
        .iter()
        .take_while(|byte| **byte == marker)
        .count();
    (length >= 3).then_some((marker, length))
}

fn closes_fence(line: &[u8], marker: u8, opening_length: usize) -> bool {
    let Some((candidate, length)) = opens_fence(line) else {
        return false;
    };
    candidate == marker
        && length >= opening_length
        && line
            .iter()
            .skip_while(|byte| **byte == b' ')
            .skip(length)
            .all(|byte| matches!(byte, b' ' | b'\t'))
}
