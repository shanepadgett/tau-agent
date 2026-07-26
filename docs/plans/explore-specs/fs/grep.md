# `grep`

## Purpose

- Same job as stock Pi `grep`: literal/regex content search via ripgrep.
- Explore value: **per-file grouped** agent text (path once, line rows under it), caps, ignore defaults ([output-density.md](../cross/output-density.md)).

## Parameters

Pi-compatible shape:

Top-level:

- `queries` (required, min 1)
- `limit` (optional number) — default `100`
- `maxPerFile` (optional number) — default `8`
- `maxLineLength` (optional number) — clip long lines in output
- `contextOnly` (optional boolean)
- `stopAfterLimit` (optional boolean)
- `hidden` / `noIgnore` (optional boolean) — defaults applied to queries when set

Per query:

- `patterns` (required string[], min 1)
- `paths` (optional string[])
- `include` / `exclude` (optional string[])
- `regex` (optional boolean)
- `case` (optional) — `smart` | `sensitive` | `insensitive`
- `word` (optional boolean)
- `context` (optional number)
- `hidden` / `noIgnore` (optional boolean)

## Behavior

- Requires `rg` on PATH; clear error if missing.
- Paths/ignore defaults follow [path-conventions.md](../cross/path-conventions.md).
- Divide `limit` across queries; enforce `maxPerFile`.
- Large agent payloads still pass through [bounded-output.md](../cross/bounded-output.md).
- **Agent output:** for each file with hits, one path header, then match rows with line numbers and **exact** line text (plus context lines if requested). Do not repeat the full path on every match line.
- Multi-query: `query i` separator only when more than one query.
- Omission notices for global limit and per-file cap (counts only).
- `stopAfterLimit`: stop gathering once budget filled.
- Clip lines only via `maxLineLength`, with visible clip — do not paraphrase matches.
- No scores, no rg command echo, no “matched N files” banners on success, no file total-line-count headers unless needed for a concrete agent action (default: omit).

## Errors / edge cases

- Missing/failing ripgrep → explicit error
- Cancellation honored

## Non-goals

- Not AST search
- Does not rewrite match text for “helpfulness”
