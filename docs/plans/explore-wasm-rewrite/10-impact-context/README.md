# Task 10 — `impact` and `context` composites

## Goal

Two composite tools over the task 08/09 backends. Staged. No new graph mechanics here — composition and packing only.

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

## Tests

Impact section composition + mode filtering on a fixture repo; context packing: budget large enough for all bodies, tight budget forcing signature downgrades and skips, dedupe across sections, type-target variant, `budget < 1` error.
