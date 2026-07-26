# `find`

## Purpose

- Find files and directories by structured path queries (globs/patterns), not content.

## Parameters

Top-level:

- `queries` (required, min 1) — list of query objects
- `limit` (optional number) — total match budget; default `100`

Per query:

- `path` (optional string) — search root
- `patterns` (optional string[]) — path globs/patterns to match
- `type` (optional) — `file` | `dir` | `any`
- `maxDepth` (optional number) — depth limit; omit for unlimited (within other safety)
- `hidden` (optional boolean) — include hidden segments when true
- `noIgnore` (optional boolean) — include ignored and noise paths when true

## Behavior

- Run each query independently; divide `limit` across queries.
- Match patterns against slash-normalized relative/display paths.
- Patterns can match paths with or without a leading `./`-style segment convenience where implemented.
- Default traversal: ignore-aware, hidden off, noise off.
- File roots may include the root file itself (`includeRoot` when root is a file).
- Output path tree / compact match list with omission notices when truncated by limit.

## Errors / edge cases

- Bad path → clear error
- No matches → empty result, not a hard failure
- Cancellation honored

## Non-goals

- Not content search (`grep`) and not structural search (`ast_search`)
- Does not unlock read gate
- Does not issue structural locators
