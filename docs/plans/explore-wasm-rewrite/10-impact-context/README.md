# Task 10 — `impact` and `context` composites

## Cold start

Fresh window: read [`../COLD-START.md`](../COLD-START.md), [`../LIVE-PROVE.md`](../LIVE-PROVE.md), this file, impact/context/settings specs, then relationships + file-graph + show view extraction. **No new tests.** Compose only — no new graph engine. Live per Done when. `check:ts` green.

Depends on: 09.

## Goal

Two composite tools over the task 08/09 backends. Register when they work. No new graph mechanics — composition and packing only.

Specs: `explore-specs/graph/impact.md`, `explore-specs/graph/context.md`, `explore-specs/cross/settings.md` (`context.defaultBudgetTokens` = 8000).

## Files

```text
packages/agent/extensions/explore/ast/queries/impact.ts
packages/agent/extensions/explore/ast/queries/context.ts
packages/agent/extensions/explore/ast/format/impact.ts
packages/agent/extensions/explore/ast/format/context.ts
packages/agent/extensions/explore/ast/tools/impact.ts
packages/agent/extensions/explore/ast/tools/context.ts
```

## `impact`

- Params: `path` scope, target identity, `depth` (default 2), `mode` (`all` | `deps` | `dependents`).
- Sections in spec order, empty sections dropped: callees / file imports (depth 1) / callers / file importers (depth 1) / transitive dependents (`2..depth`, via reverse file graph BFS from the defining file). Mode table per spec.
- Header once: resolved target path, name, kind, line. Rows grouped by file inside sections; depth labels on transitive rows; certainty only when not exact. No test sections (stripped).

## `context`

- Params: `path` scope, target identity, `budget` (default from settings).
- Packing order per spec, callable vs type variants. Entry ladder: body → signature → skip with `truncated` flag. Token estimate `Math.ceil(bytes / 4)`. Never exceed `budget`; dedupe symbols across sections; external/missing body → `body_unavailable` + signature.
- Bodies/signatures are byte slices via the same view logic as `show` (reuse `queries/show.ts` view extraction — do not duplicate it).
- Header: target, `budget`, `used`. Then labeled groups; exact source, no tree compression inside entries. After packing, still run through the shared bounded handler (both limits apply, `bounded-output.md`).

## Done when

After `/reload`, real `impact` / `context` tools per [`../LIVE-PROVE.md`](../LIVE-PROVE.md):

- `impact` modes on symbols from `pi` or `excalidraw`, plus at least one real hit per other programming corpus language (file-import sections use task 08 graph).
- `context` loose and tight budgets (signature downgrade / skip) on corpus symbols — TS plus at least two non-TS languages.
- `budget < 1` errors.
