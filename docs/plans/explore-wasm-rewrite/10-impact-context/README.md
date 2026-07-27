# Task 10 — `impact` and `context` composites

## Status: DONE (as built — read before task 12/13)

Shipped and LIVE-PROVEd on corpus. Normative = **disk + this banner**.

**As built:**

- Tools registered: `impact`, `context` in `index.ts` via `engineFor`/`graphFor`/`rowState`/`temporaryOutput`.
- Queries: `ast/queries/impact.ts`, `ast/queries/context.ts`; shared target gate `ast/queries/composite-target.ts` (callable/type only).
- Format: `ast/format/impact.ts`, `ast/format/context.ts`, shared `ast/format/composite.ts` section blocks; ambiguous targets reuse `formatCandidateList`.
- Show body/sig slices: `extractShowView` exported from `ast/queries/show.ts`.
- Settings: `packages/agent/extensions/explore/settings.ts` with **only** `explore.context.defaultBudgetTokens` = 8000. Task 12 **extends** this file (do not recreate/move).
- **impact knobs:** section cap 50 (no public `resultLimit`); `depth` default 2 max 5 applies to **file** reverse BFS only; symbol callees/callers depth 1 via `queryRelationships`; modes `all`|`deps`|`dependents`.
- **context knobs:** default budget from settings; token est `ceil(text.length/4)`; rel limit 20; follow-up N 8; method cap 12; body→sig→skip; depth-2 = capped second resolve pass (not relationship depth).
- File-import quality depends on task 08 resolvers (C#/JVM/TS paths/Odin bounds). Composites must not add language switches or re-expand namespaces.
- Kind helpers: `isTypeLike` / `isCallableLike` on `ast/ir.ts`.

## Cold start

Fresh window: read [`../COLD-START.md`](../COLD-START.md), [`../LIVE-PROVE.md`](../LIVE-PROVE.md), this file, impact/context/settings specs, then **shipped** relationships + file-graph + show. Read the **Status: DONE** banner at the top of [`../09-relationships/README.md`](../09-relationships/README.md) — ignore that file’s historical `collectOccurrences` design. **No new tests.** Compose only — no new graph engine, no new call-site extraction. Live per Done when. `check:ts` green.

Depends on: 09 (done).

## Goal

Two composite tools over the task 08/09 backends. Register when they work. No new graph mechanics — composition and packing only.

Specs: `explore-specs/graph/impact.md`, `explore-specs/graph/context.md`, `explore-specs/cross/settings.md` (`context.defaultBudgetTokens` = 8000).

## Existing surfaces to compose (do not rebuild any of these)

- Target resolution: `resolveTarget` in `ast/identity.ts` (returns `resolved` / `candidates` / `notFound`; stop at candidates like `show` does). Prefer resolving **once** in the composite, then pass a fixed target into section builders — do not thrash `resolveTarget` per section unless a section truly needs a different name.
- File graph: `ExploreFileGraph` from `ast/graph/file-graph.ts` — `forwardEdges(path)` for depth-1 imports, `reverseDeps(path, depth, limit)` for importers/transitive **file** dependents. Get it through the `graphFor(cwd)` accessor in `index.ts`, same as `deps`/`reverse_deps`.
- Relationships: `queryRelationships` in `ast/graph/relationships.ts` (`RelationshipOp`, `RelationshipQueryResult`, `RelationshipSite`). **Call this function, not the four tools.** Ops: `callers` | `callees` | `references` | `implementations`. Depth is **1 only** — there is no symbol-edge BFS. Certainty / overload collapse / receiver rules are already inside that query; formatters may omit `exact` labels the same way `format/relationships.ts` does.
- IR facts already on decls (do not re-walk trees for impact/context): `Decl.calls`, `Decl.bases`, `ImportRef.bindings`. Composites must not add adapter hooks.
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
- Sections in spec order, empty sections dropped:
  1. **callees** — `queryRelationships({ op: "callees", … })` (symbol depth 1 only).
  2. **file imports** — `forwardEdges(target.path)` depth 1.
  3. **callers** — `queryRelationships({ op: "callers", … })` (symbol depth 1 only).
  4. **file importers** — reverse file edges depth 1.
  5. **transitive dependents** — reverse **file** graph BFS depths `2..depth` from the defining file (`reverseDeps`). Spec wording “caller-side” means dependent files, **not** multi-hop symbol callers. Do not invent symbol-call BFS.
- Mode table per spec. Header once: resolved target path, name, kind, line. Rows grouped by file; depth labels on transitive **file** rows; certainty only when not exact. Reuse relationship row density (preview, kind). No test sections (stripped).
- Keep scopes narrow in LIVE-PROVE (same corpus packages as 08/09). Whole-repo impact is not a goal.

## `context`

- Params: `path` scope, target identity, `budget` (default from settings).
- Packing order per spec, callable vs type variants, with this **depth honesty** vs `context.md`:
  - Direct callees / direct callers / implementors = one `queryRelationships` hop each (`callees` / `callers` / `implementations`).
  - Spec items “depth-2 callee/caller signatures”: **optional second pass only** — take first-hop site names, resolve+query again under the same scope, signatures only, hard cap on follow-ups (small fixed N, e.g. ≤ 8). If budget or N is exhausted, stop. Do **not** add a `depth` param to relationships or a new graph engine.
  - Type “dependents (callers of methods)”: for each method child of the type (or a capped subset), `callers` once; signatures only.
- Entry ladder: body → signature → skip with `truncated` flag. Token estimate `Math.ceil(text.length / 4)` on the sliced string (UTF-16 code units, decision 12 — ignore `context.md` “bytes” wording). Never exceed `budget`; dedupe symbols across sections; external/missing body → `body_unavailable` + signature.
- Bodies/signatures are exact source slices via the same view logic as `show` (the exported view-extraction function above — do not duplicate it).
- Header: target, `budget`, `used`. Then labeled groups; exact source, no tree compression inside entries. After packing, still run through the shared bounded handler (both limits apply, `bounded-output.md`).

## Done when

After `/reload`, real `impact` / `context` tools per [`../LIVE-PROVE.md`](../LIVE-PROVE.md):

- `impact` modes on symbols from `pi` or `excalidraw`, plus at least one real hit per other programming corpus language (file-import sections use task 08 graph).
- `context` loose and tight budgets (signature downgrade / skip) on corpus symbols — TS plus at least two non-TS languages.
- `budget < 1` errors.
