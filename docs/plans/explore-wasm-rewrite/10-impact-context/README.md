# Task 10 — `impact` and `context` composites

## Cold start

Fresh window: read [`../COLD-START.md`](../COLD-START.md), [`../LIVE-PROVE.md`](../LIVE-PROVE.md), this file, impact/context/settings specs, then relationships + file-graph + show view extraction. **No new tests.** Compose only — no new graph engine. Live per Done when. `check:ts` green.

Depends on: 09.

## Goal

Two composite tools over the task 08/09 backends. Register when they work. No new graph mechanics — composition and packing only.

Specs: `explore-specs/graph/impact.md`, `explore-specs/graph/context.md`, `explore-specs/cross/settings.md` (`context.defaultBudgetTokens` = 8000).

## Existing surfaces to compose (do not rebuild any of these)

- Target resolution: `resolveTarget` in `ast/identity.ts` (returns `resolved` / `candidates` / `notFound`; stop at candidates like `show` does).
- File graph: `ExploreFileGraph` from `ast/graph/file-graph.ts` — `forwardEdges(path)` for depth-1 imports, `reverseDeps(path, depth, limit)` for importers/transitive dependents. Get it through the `graphFor(cwd)` accessor in `index.ts`, same as `deps`/`reverse_deps`.
- Relationships: the task 09 pipeline (`ast/graph/relationships.ts` operation enum) for callers/callees sections. Call the query function, not the tools.
- Body/signature extraction for `context` entries: `queries/show.ts` builds view text in a private `buildBlock`. Export a narrower view-extraction function from `queries/show.ts` (decl + path + ir + source + view → text) and use it from both `show` and `context`. Do not duplicate the view logic and do not export the whole batch machinery.
- Wiring: register both tools in `index.ts` with the existing `rowState` / `temporaryOutput` / `engineFor` / `graphFor` pattern.

## Settings ordering

This task runs before task 12, and `context` needs `explore.context.defaultBudgetTokens` (8000). Create `packages/agent/extensions/explore/settings.ts` here with **only** that key, following `packages/agent/shared/settings/define.ts` and AGENTS.md extension-settings rules (schema sync regenerates `tau.schema.json`; never edit it; do not read the schema in the same tool batch that writes settings). Task 12 extends the same file with the read thresholds.

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
- Packing order per spec, callable vs type variants. Entry ladder: body → signature → skip with `truncated` flag. Token estimate `Math.ceil(text.length / 4)` on the sliced string (offsets are UTF-16, decision 12 — no byte math). Never exceed `budget`; dedupe symbols across sections; external/missing body → `body_unavailable` + signature.
- Bodies/signatures are exact source slices via the same view logic as `show` (the exported view-extraction function above — do not duplicate it).
- Header: target, `budget`, `used`. Then labeled groups; exact source, no tree compression inside entries. After packing, still run through the shared bounded handler (both limits apply, `bounded-output.md`).

## Done when

After `/reload`, real `impact` / `context` tools per [`../LIVE-PROVE.md`](../LIVE-PROVE.md):

- `impact` modes on symbols from `pi` or `excalidraw`, plus at least one real hit per other programming corpus language (file-import sections use task 08 graph).
- `context` loose and tight budgets (signature downgrade / skip) on corpus symbols — TS plus at least two non-TS languages.
- `budget < 1` errors.
