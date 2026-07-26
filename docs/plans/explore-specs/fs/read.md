# `read`

## Purpose

- Read text or image file contents with optional line ranges and line numbers.
- Apply structural read policy for supported source ([read-policy.md](../cross/read-policy.md), thresholds in [settings.md](../cross/settings.md)).
- Avoid resending unchanged complete-file contents when the session still holds trusted baseline knowledge.
- Snapshot/lifecycle rules align with [system.md](../cross/system.md). Large body results still honor [bounded-output.md](../cross/bounded-output.md).

## Parameters

- `path` (required string) — relative or absolute
- `offset` (optional number) — 1-indexed start line
- `limit` (optional number) — max lines to return from offset
- `lineNumbers` (optional boolean) — prefix lines with 1-indexed numbers

## Behavior — media types

- Supported images: delegate to the base image read path.
- Non-UTF8 / binary text decode failure: fall back to base read behavior rather than crashing.
- UTF-8 text: Explore caching + structural read policy apply.

## Behavior — structural policy

- See [read-policy.md](../cross/read-policy.md).
- Large supported full read → outline substitution (success).
- Ranged supported read → at most `maxRangeLines` lines.
- Markdown always allowed full read.

## Agent output

- Body/outline text only plus necessary unchanged/diff/truncation notices ([output-density.md](../cross/output-density.md)).
- Exact file bytes/lines for body reads — no paraphrase.
- No read-stats, gate, or cache-mode essays in the model payload (short unchanged/diff markers are fine).

## Behavior — ranges and limits

- `offset` beyond EOF → error naming total lines.
- Apply shared head byte/line limits to the selected slice after structural range caps.
- Single line larger than max bytes → explicit error/guidance to use a shell slice, not a silent empty read.
- Partial truncation of a multi-line slice → notice with next `offset` hint when continuing by lines/bytes.
- Complete-file means: starts at beginning, includes through end, was not outline-substituted, and was not truncated by output limits.

## Behavior — complete-file knowledge

When a complete file is cacheable and trusted baseline exists in session context:

- **unchanged** — content hash matches baseline; return a short unchanged marker instead of full text
- **diff** — content changed; return a compact patch/diff against baseline when possible
- **baseline** — first complete delivery of current contents
- **recovery** — baseline missing/unusable after compaction or invalidated chain; return full current source safely (still subject to structural full-read policy: large supported files outline-substitute even in recovery)

Partial-range reads can still short-circuit as **unchanged** for the same ranged scope hash when applicable.

## Snapshots

- Successful text body reads may store content snapshots keyed by hash for later diff/unchanged decisions.
- Outline-substituted large full reads are not complete-file body baselines.
- Snapshot store clears on session compact/tree/start as defined in system lifecycle.
- If snapshot epoch goes stale mid-operation, do not use stale baseline decisions.

## Errors / edge cases

- Missing file / unreadable path → normal FS error
- Aborted signal → aborted error
- Range wider than `maxRangeLines` on supported source → error to shrink range
- Never a “blocked until structural attempt” error

## Non-goals

- Not a substitute for `outline`/`show` when only signatures or one declaration are needed
- Does not issue session locators
- Does not write files
