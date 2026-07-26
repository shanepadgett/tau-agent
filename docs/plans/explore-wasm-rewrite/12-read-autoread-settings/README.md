# Task 12 — `read` policy, autoread, settings

## Goal

New structural read behavior, simplified complete-file cache, reworked autoread, new settings. The old implementations live only in the archive: `docs/plans/explore-archive/explore/read.ts` (read the media/binary handling before writing the new tool), `read-snapshots.ts` (lifecycle event subscriptions), `autoread.ts`, `read-cache.ts` (do not resurrect the transcript-replay machinery).

Specs (all normative): `explore-specs/cross/read-policy.md`, `explore-specs/fs/read.md`, `explore-specs/session/autoread.md`, `explore-specs/cross/settings.md`.

## Files

```text
packages/agent/extensions/explore/ast/read/policy.ts      threshold + range decisions (pure)
packages/agent/extensions/explore/ast/read/snapshots.ts   session snapshot store (in-memory)
packages/agent/extensions/explore/ast/read/read-tool.ts   the tool
packages/agent/extensions/explore/ast/read/autoread.ts
packages/agent/extensions/explore/settings.ts             NEW: read + context keys only (the archived settings had readGate — do not carry it over)
```

## Settings

`explore.read.structureThresholdLines` (200), `explore.read.maxRangeLines` (200), `explore.context.defaultBudgetTokens` (8000). Delete the entire `readGate` object and any read-stats-only keys. Follow `packages/agent/shared/settings/define.ts` patterns. **Do not touch `packages/agent/schemas/tau.schema.json`** — the sync extension regenerates it; do not read the schema in the same tool batch that writes settings.

## Read behavior

- Full read, supported non-Markdown source, `lineCount > structureThresholdLines` → **outline substitution** (task 06 file-outline shape) + one instruction line ("large file: use ranged read or show for bodies"). This is success, never an error. Not a body baseline.
- Full read at/under threshold, Markdown, unsupported, binary/images → current base behavior (delegate image/binary paths exactly as the existing `read.ts` does — read it for the media handling before writing this).
- Ranged read: always allowed; slice capped at `maxRangeLines` (over-ask → error telling caller to shrink); `offset` past EOF → error naming total lines; head byte/line limits apply to the slice afterward.
- There is **no blocked-read error path** and no attempt registry. If you find yourself writing one, re-read `stripped.md`.

## Complete-file cache (the simple version)

`snapshots.ts`: in-memory map `path → { hash, content }` recorded on complete body deliveries (read and full-file autoread). Modes per `fs/read.md`: `unchanged` (hash match → short marker), `diff` (changed → compact unified diff against stored baseline, computed from stored content — **no transcript replay, no diff re-application, no baseline reconstruction**), `baseline`, `recovery` (store cleared → full current source, still threshold-policed). Store clears on session start / compact / tree-change events (see how current `read-snapshots.ts` subscribes to lifecycle; reuse the event names, not the code). Ranged reads may return `unchanged` for the same range hash.

## Autoread

Autoread currently lives at `packages/agent/shared/autoread.ts` with `registerAutoread` called by the context-pruning extension (interim wiring from the archive change). This task moves registration into Explore's `index.ts` and removes the context-pruning call, while `prepareAutoreadMessage`/`createCompleteFileMeta` stay in `shared/` for context-pruning, handoff, and subagent. New policy per spec: supported source ≤ threshold → full text + snapshot registration; above threshold → outline only, no body, no snapshot; Markdown/unsupported text → full within size limits. Stale lifecycle mid-flight → do not commit knowledge. Failures become status details, not invented content.

## Tests

Policy table tests (pure), threshold boundary (exactly 200 lines), range cap, EOF offset error, unchanged/diff/baseline/recovery transitions, snapshot clear on lifecycle events, autoread outline vs full paths.
