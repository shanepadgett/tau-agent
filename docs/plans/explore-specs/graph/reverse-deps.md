# `reverse_deps`

## Purpose

- File-level: who imports this file.
- Shared backend with [impact.md](impact.md) file-importer section; session graph cache per [system.md](../cross/system.md).

## Parameters

- `path` (required string) — source file
- `depth` (optional int ≥ 1, default `1`)
- `resultLimit` (required int 1…100)

## Agent output

Per [output-density.md](../cross/output-density.md):

- List importing files with depth when `depth` > 1.
- Path factoring when helpful.
- Edge kind only when known and useful.
- **No** scores or graph telemetry.
- Empty → one-line empty. Omission footer if limited.

## Errors / edge cases

- Missing/non-file, unsupported dep extraction, engine, cancel

## Non-goals

- Not symbol callers; not full graph dump; no writes
