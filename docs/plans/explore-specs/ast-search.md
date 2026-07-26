# `ast_search`

## Purpose

- Find code shapes with ast-grep patterns across one supported file or a directory tree.
- Return exact previews, metavariable bindings, parser uncertainty, and numeric locators for matches and enclosing scopes.

## Parameters

- `path` (required string) — file, repository, package, or subtree
- `pattern` (required string, 1…16KiB) — ast-grep pattern (`$NAME`, `$$$NAME`, etc.)
- `language` (optional enum) — `typeScript` | `tsx` | `odin` | `go` | `rust` | `cSharp` | `java` | `kotlin` | `swift` | `markdown`
- `resultLimit` (required int 1…100)

## Language resolution

- Supported file path: language may be inferred from extension.
- Directory path: `language` is required.
- If both inferred and provided: they must match, else error.
- Unsupported file type → error.

## Behavior

- Search is deterministic and bounded by result limit plus traversal budgets.
- Each match includes:
  - relative path + line range
  - numeric match locator
  - language + parse certainty
  - source preview (may be truncated with notice)
  - metavariable bindings with previews (may truncate values/bindings with notice)
  - optional enclosing scope with its own locator and ast kind
  - certainty reason when uncertain
- Diagnostics for problem files are listed explicitly; omitted diagnostic counts may appear in exceptions.
- No matches → explicit empty result (still success).
- Direct-file zero-match completion still records the target file fingerprint for orientation when reported by the worker.
- Exception footers only for omitted matches, exception counts, or limits reached.
- Output uses complete-block bounding + temp overflow rules.
- Match/scope locators for non-visible units are dropped.

## Read gate / orientation

- Matches record `structuralMatch` attempts for their files.
- Direct-file searches with a reported target fingerprint record that fingerprint even when match list is empty.

## Errors / edge cases

- Missing language on directory
- Language mismatch on file
- Unsupported file
- Invalid/too-long pattern
- Worker unavailable
- Cancellation

## Non-goals

- Not literal text search (`grep`)
- Does not edit code
