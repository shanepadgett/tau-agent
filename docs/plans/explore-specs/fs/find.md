# `find`

## Purpose

- Same job as stock Pi `find`: path queries by glob/pattern, not content.
- Explore value: **path-tree factoring** of matches + ignore defaults + caps ([output-density.md](../cross/output-density.md)).

## Parameters

Pi-compatible shape:

- `queries` (required, min 1)
- `limit` (optional number) — default `100`

Per query:

- `path` (optional string)
- `patterns` (optional string[])
- `type` (optional) — `file` | `dir` | `any`
- `maxDepth` (optional number)
- `hidden` (optional boolean)
- `noIgnore` (optional boolean)

## Behavior

- Run queries independently; divide `limit` across them.
- Default traversal: ignore-aware, hidden off, noise off ([path-conventions.md](../cross/path-conventions.md)).
- Match on slash-normalized display paths.
- **Agent output:** path tree of matches under each query root (not a flat list of full paths) ([output-density.md](../cross/output-density.md)). Multi-query: minimal `query i` separator only when more than one query.
- No matches → short empty result, not failure.
- Omission notice when limited (counts only).
- Large results still pass [bounded-output.md](../cross/bounded-output.md).
- No ranking scores, no engine stats, no pattern echo preambles.

## Errors / edge cases

- Bad path → clear error
- Cancellation honored

## Non-goals

- Not content search (`grep`) or shape search (`ast_search`)
