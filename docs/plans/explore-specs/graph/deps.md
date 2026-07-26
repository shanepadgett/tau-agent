# `deps`

## Purpose

- File-level: what this file imports/depends on.
- Shared backend with [impact.md](impact.md) file-import section; session graph cache per [system.md](../cross/system.md).

## Parameters

- `path` (required string) — source file
- `depth` (optional int ≥ 1, default `1`)
- `resultLimit` (required int 1…100)

## Agent output

Per [output-density.md](../cross/output-density.md):

- List dependent files with depth when `depth` > 1.
- Path factoring if presenting a small tree helps; no full-path spam.
- Edge kind only when known and useful.
- **No** scores, graph stats, or timing.
- Empty → one-line empty. Omission footer if limited.

## Errors / edge cases

- Missing/non-file, unsupported dep extraction, worker, cancel

## Non-goals

- Not symbol callees; not cycle CI tool; no writes
