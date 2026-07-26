# `read` (harness / Pi)

## Ownership

- **Pi/harness built-in.** Explore does not register `read`.
- Explore applies structural overlay only ([read-policy.md](../cross/read-policy.md)).

## Purpose

- Read text or image file contents with optional line ranges and line numbers (Pi behavior).
- For large supported source full reads: model sees outline, not body (Explore `tool_result` overlay).
- No Explore complete-file unchanged/diff cache ([stripped.md](../stripped.md)).

## Parameters

Pi’s `read` surface (canonical):

- `path` (required string) — relative or absolute
- `offset` (optional number) — 1-indexed start line
- `limit` (optional number) — max lines to return from offset

(line-number presentation follows Pi defaults unless product later specifies otherwise.)

## Behavior — media types

- Images / binary / decode fallback: Pi base path. Explore overlay does not run.

## Behavior — structural overlay

- See [read-policy.md](../cross/read-policy.md).
- Large supported full read → outline substitution (success; model-visible content replaced).
- Ranged supported read → at most `maxRangeLines` lines.
- Markdown always allowed full read.

## Agent output

- Body or outline text only plus necessary truncation notices ([output-density.md](../cross/output-density.md)).
- Exact file bytes/lines for body reads — no paraphrase.
- No read-stats, gate, cache-mode, or “blocked until outline” essays.

## Explicitly absent

- Explore-owned `read` tool implementation
- Unchanged / diff / baseline / recovery modes
- Read-gate unlock errors
- `/read-stats`

## Non-goals

- Not a general binary editor
- Not a substitute for `show` when the agent already has path+name
