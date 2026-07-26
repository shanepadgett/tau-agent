# Task 07 — `discover` tool

## Cold start

Fresh window: read [`../COLD-START.md`](../COLD-START.md), this file, `explore-specs/shape/discover.md` + output-density/bounded-output, then outline tool + scan + engine as patterns. **No new tests.** Register when done. Live per Done when. `check:ts` green.

Depends on: 06.

## Goal

Repo/package/subtree declaration discovery replacing `api_discover`. Register when it works.

Spec: `explore-specs/shape/discover.md`.

## Files

```text
packages/agent/extensions/explore/ast/queries/discover.ts
packages/agent/extensions/explore/ast/format/discover.ts
packages/agent/extensions/explore/ast/tools/discover.ts
```

## Behavior

- Params exactly per spec: `path` (directory only — file → error), `query` tagged union (`exactName` | `prefixName` | `substringName` | `fuzzyName` | `declarationKind` | `documentation`), `surface` enum, `resultLimit` 1–100.
- Stream `FileIr` from `scan.ts`; match decls per query kind:
  - name kinds: case-sensitive on `name` and `qualifiedName` tail segment.
  - `fuzzyName`: bounded edit-distance/subsequence scoring; `maxWork` counts candidate comparisons; when exceeded, stop and set the budget flag. Do not expose scores in output — scoring is selection-only.
  - `documentation`: term match over doc-span text of decls that have one; `maxWork` counts decls inspected.
- `surface` filters: `public` (visibility public + exported where the language has exports), `private` (inverse), `sourceExport` (`exported === true`), `packageSurface` (adapter capability required; v1 only TS/TSX — resolve package entry from the nearest `package.json` `exports`/`main` and include only decls reachable from it; other languages → clear capability error per `system.md`), `all`.
- Re-export chains: TS only, and only when cheap — follow `export * from` / `export { X } from` one file at a time through the engine cache with a small depth cap (4). Others omit; no "unknown" strings anywhere.

## Output

Per `output-density.md`: group by defining file, path header once; each candidate `L<start>-<end>`, kind, signature slice; import/access path only when `packageSurface`/`sourceExport` made it the point. No scores, no work counters unless a budget tripped (one footer line). Complete-block bounding + temp overflow. Empty → one line.

## Done when

Live: each query kind on a real subtree; surface filters; directory-only validation; resultLimit footer when cut.
