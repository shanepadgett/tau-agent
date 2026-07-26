# `ast_search`

## Purpose

- Find code shapes with ast-grep patterns in one file or a tree.
- Search only. No writes.

## Parameters

- `path` (required string)
- `pattern` (required string, 1…16KiB)
- `language` (optional string) — worker-registered language id (required for directory targets)
- `resultLimit` (required int 1…100)

## Language resolution

- File: infer from extension when possible; provided language must match if both set ([system.md](../cross/system.md) registration).
- Directory: `language` required.
- Unregistered language/type → error.
- Directory walks honor [path-conventions.md](../cross/path-conventions.md) budgets.

## Agent output

Per [output-density.md](../cross/output-density.md):

- Group matches **by file** (path once).
- Each match: line range, **exact** preview (edit-grade), metavariable bindings with exact previews when present.
- Enclosing scope only when it helps disambiguate (name/kind/line) — not a second full dump.
- Parse uncertainty label only when not certain.
- **No** scores, locator fields, pattern-echo headers, or per-file language tags when the call already fixed language.
- Empty match list → success with short empty message.
- Footers only for omitted matches, file diagnostics, budgets.
- Complete-block bounding + temp overflow ([bounded-output.md](../cross/bounded-output.md)).

## Errors / edge cases

- Missing language on directory
- Language mismatch on file
- Bad/too-long pattern
- Worker unavailable
- Cancellation

## Non-goals

- Not `grep`
- Not structural rewrite writes
