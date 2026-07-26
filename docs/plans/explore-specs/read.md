# `read`

## Purpose

- Read text or image file contents with optional line ranges and line numbers.
- For gated supported source, require a current structural attempt first ([read-gate.md](read-gate.md)).
- Avoid resending unchanged complete-file contents when the session still holds trusted baseline knowledge.

## Parameters

- `path` (required string) — relative or absolute
- `offset` (optional number) — 1-indexed start line
- `limit` (optional number) — max lines to return from offset
- `lineNumbers` (optional boolean) — prefix lines with 1-indexed numbers

## Behavior — media types

- Supported images: delegate to the base image read path.
- Non-UTF8 / binary text decode failure: fall back to base read behavior rather than crashing.
- UTF-8 text: Explore caching + gate logic applies.

## Behavior — ranges and limits

- `offset` beyond EOF → error naming total lines.
- Apply shared head byte/line limits to the selected slice.
- Single line larger than max bytes → explicit error/guidance to use a shell slice, not a silent empty read.
- Partial truncation of a multi-line slice → notice with next `offset` hint when continuing by lines/bytes.
- Complete-file means: starts at beginning, includes through end, and was not truncated by output limits.

## Behavior — complete-file knowledge

When a complete file is cacheable and trusted baseline exists in session context:

- **unchanged** — content hash matches baseline; return a short unchanged marker instead of full text
- **diff** — content changed; return a compact patch/diff against baseline when possible
- **baseline** — first complete delivery of current contents
- **recovery** — baseline missing/unusable after compaction or invalidated chain; return full current source safely

Partial-range reads can still short-circuit as **unchanged** for the same ranged scope hash when applicable.

## Behavior — read gate

- See [read-gate.md](read-gate.md) for full rules.
- Gated + blocked without patch exception → throw; do not return contents.
- Record permitted/blocked reads for telemetry.

## Snapshots

- Successful text reads may store content snapshots keyed by hash for later diff/unchanged decisions.
- Snapshot store clears on session compact/tree/start as defined in system lifecycle.
- If snapshot epoch goes stale mid-operation, do not use stale baseline decisions.

## Errors / edge cases

- Missing file / unreadable path → normal FS error
- Aborted signal → aborted error
- Gate block message must name path and suggest structural next steps

## Non-goals

- Not a substitute for `outline`/`symbol` when only signatures are needed
- Does not itself issue structural locators
