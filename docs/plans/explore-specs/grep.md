# `grep`

## Purpose

- Search file contents with structured literal/regex queries via ripgrep.

## Parameters

Top-level:

- `queries` (required, min 1) — query objects
- `limit` (optional number) — total match budget; default `100`
- `maxPerFile` (optional number) — per-file match cap; default `8`
- `maxLineLength` (optional number) — truncate long lines in output
- `contextOnly` (optional boolean) — context presentation mode
- `stopAfterLimit` (optional boolean) — stop early once enough matches collected (broad searches)
- `hidden` (optional boolean) — top-level default applied to queries when set
- `noIgnore` (optional boolean) — top-level default applied to queries when set

Per query:

- `patterns` (required string[], min 1) — even one pattern is an array
- `paths` (optional string[]) — search roots; even one path is an array
- `include` / `exclude` (optional string[]) — globs; arrays even for one value
- `regex` (optional boolean)
- `case` (optional) — `smart` | `sensitive` | `insensitive`
- `word` (optional boolean) — word-boundary matching
- `context` (optional number) — context lines
- `hidden` (optional boolean)
- `noIgnore` (optional boolean)

## Behavior

- Requires `rg` (ripgrep) on PATH; clear error if missing.
- Divide top-level `limit` across queries.
- Enforce `maxPerFile` within each query’s results.
- Report omitted matches due to limit and/or maxPerFile.
- When `stopAfterLimit` is true, stop gathering once the budget is filled rather than counting the full hit set first.
- Output groups matches by file with line content (and context if requested).
- Long lines can be clipped by `maxLineLength`.

## Errors / edge cases

- ripgrep missing → explicit install/availability error
- ripgrep non-zero failure → surface stderr/message
- Invalid param types → validation errors
- Cancellation honored
- Binary/unreadable files handled by ripgrep semantics; tool should not crash the session

## Non-goals

- Not AST/code-shape search
- Does not unlock read gate by itself
- Does not issue structural locators
