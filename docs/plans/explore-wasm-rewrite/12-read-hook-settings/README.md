# Task 12 — Pi `read` outline hook, autoread, settings

## Cold start

Fresh window: read [`../COLD-START.md`](../COLD-START.md), [`../LIVE-PROVE.md`](../LIVE-PROVE.md), this file, read-policy/settings/autoread/fs-read specs, outline query + Pi `tool_result` docs pattern (other extensions). **No new tests. No Explore `read` tool.** Live per Done when. `check:ts` green.

Depends on: 06.

## Goal

Structural large-read policy **without** an Explore `read` tool. No complete-file unchanged/diff cache. No transcript replay. No read-gate.

Specs: `explore-specs/cross/read-policy.md`, `explore-specs/cross/settings.md`, `explore-specs/session/autoread.md`, `explore-specs/fs/read.md` (harness ownership + Explore overlay only).

## Files

```text
packages/agent/extensions/explore/ast/read/policy.ts   pure threshold / full-vs-range decision
packages/agent/extensions/explore/ast/read/hook.ts    tool_result (and optional tool_call) wiring
packages/agent/extensions/explore/read/autoread.ts    large supported → outline inject
packages/agent/extensions/explore/settings.ts         read thresholds + context budget only
```

Outline text comes from the existing pipeline: `outlinePath` in `ast/queries/outline.ts` + the file formatter in `ast/format/outline.ts`. Do not write a second outline renderer for the hook. Registered-language detection: `engine.registry.adapterForPath` — **including Markdown** (heading outline). Any path with an adapter is eligible; unregistered / image / binary only no-op. Wire hook + autoread registration in `index.ts` next to the existing tool registrations, using `engineFor`.

## Settings

`explore.read.enabled` (boolean, default `true`) — master switch for the structural read overlay **and** large-source autoread outline path. When `false`, Pi `read` and autoread behave as ordinary full/ranged Pi paths (no outline substitution, no `maxRangeLines` enforcement from Explore).

`explore.read.structureThresholdLines` (200), `explore.read.maxRangeLines` (200). `explore.context.defaultBudgetTokens` (8000) **already exists** in `packages/agent/extensions/explore/settings.ts` (task 10 DONE) — **extend that file only**, do not recreate, move, or reset the context key. No `readGate`. No read-stats keys. Follow `packages/agent/shared/settings/define.ts`. **Do not touch `packages/agent/schemas/tau.schema.json`** — schema sync regenerates it; do not read the schema in the same tool batch that writes settings.

## Pi `read` hook (the product)

Leave Pi's built-in `read` registered. Explore never `registerTool("read")`.

### `tool_result` (required)

On successful `read` of a path:

0. If `explore.read.enabled` is `false` → no-op (entire overlay off).
1. Resolve path; if not registered structural source (no adapter), or image/binary → no-op. Markdown **is** registered and **is** overlaid.
2. If the call is a **ranged** read (`offset` and/or `limit` set in a way that is not "whole file") → no-op on body substitution. Optionally enforce `maxRangeLines` by truncating/replacing with an error result telling the caller to shrink (prefer hard error over silent over-long slice).
3. If **full** read and file line count **>** `structureThresholdLines` → replace `event.content` with outline text for that file (task 06 shape; Markdown → headings/section ranges) plus one instruction line ("large file: use ranged read or show for bodies"). `isError: false`. **Full file bytes must not remain in model-visible content.**
4. Full read at/under threshold → no-op (Pi body stands), including small Markdown.

Do **not** use `tool_call` `{ block: true }` for this policy. Block is the old gate. Substitution is a successful result reshape.

Implementation may still touch disk inside Pi's read before the hook runs; that is fine. Context only sees the replaced content.

### `tool_call` (optional, narrow)

- Mutate over-large `limit` down, or leave enforcement to `tool_result`.
- Never block large full reads.

## Explicitly absent

- Explore `read` tool
- In-memory or transcript complete-file baseline / unchanged / diff / recovery modes
- Orientation attempt registry, blocked-read errors, `/read-stats`
- Anything in `stripped.md` under read gate or read-stats

## Autoread

Autoread registration moves into Explore's `index.ts`; remove the interim context-pruning call. `prepareAutoreadMessage` / helpers that prune/handoff/subagent need stay in `packages/agent/shared/autoread.ts`.

Policy:

- `explore.read.enabled` is `false` → ordinary full inject within size limits (no outline path).
- Registered source (incl. Markdown) ≤ threshold → full text inject (no Explore body-cache bookkeeping beyond what shared already needs for "file was shown").
- Registered source (incl. Markdown) > threshold → **outline only** (Markdown → headings); no full body inject.
- Unregistered text → full within size limits.
- Stale lifecycle mid-flight → do not commit knowledge.
- Failures → status details, not invented content.

No dependency on complete-file unchanged/diff machinery.

## Done when

Live after `/reload` (real Pi `read`, not a fake). Prefer large files from [`../LIVE-PROVE.md`](../LIVE-PROVE.md) corpus (`pi`, `excalidraw`, plus one non-TS corpus file) and this monorepo:

- Full Pi `read` of a >200-line registered source file → outline in the tool result / context, not the body.
- Full Pi `read` of a >200-line Markdown file → heading outline only, not the body; ranged `read` / `show` still fetch sections.
- Ranged Pi `read` of the same files → real slice.
- Full read of a small registered file (incl. small `.md`) → normal Pi body.
- Autoread of a large registered path (incl. large `.md`) injects outline only.
- With `explore.read.enabled: false`, large full Pi `read` and large autoread keep ordinary full bodies (no outline substitution).
- Settings load; no `readGate` in schema after sync.
