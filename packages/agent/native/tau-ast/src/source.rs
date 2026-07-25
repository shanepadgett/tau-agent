use crate::outline::{ParseCertainty, SourcePosition, SourceRange};

pub fn certainty(
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

pub fn certainty_reason(certainty: ParseCertainty) -> Option<String> {
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

pub fn source_range(source: &[u8], bytes: std::ops::Range<usize>) -> SourceRange {
    SourceRange {
        start_byte: bytes.start,
        end_byte: bytes.end,
        start: position(source, bytes.start),
        end: position(source, bytes.end),
    }
}

pub fn indent(source: &str) -> String {
    source
        .lines()
        .map(|line| format!("  {line}"))
        .collect::<Vec<_>>()
        .join("\n")
}

pub fn dedent(source: &str, column: usize) -> String {
    source
        .lines()
        .enumerate()
        .map(|(index, line)| {
            if index == 0 {
                return line;
            }
            let mut bytes = 0;
            for character in line.chars().take(column) {
                if !matches!(character, ' ' | '\t') {
                    break;
                }
                bytes += character.len_utf8();
            }
            &line[bytes..]
        })
        .collect::<Vec<_>>()
        .join("\n")
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
