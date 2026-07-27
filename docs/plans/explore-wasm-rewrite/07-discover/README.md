# Task 07 — `discover` tool

## Cold start

Fresh window: read [`../COLD-START.md`](../COLD-START.md), [`../LIVE-PROVE.md`](../LIVE-PROVE.md), this file, `explore-specs/shape/discover.md` + output-density/bounded-output, then outline tool + scan + engine as patterns. **No new tests.** Register when done. Live per Done when. `check:ts` green.

Depends on: 06.

Note: outline/show each hand-roll shrinking TUI title variants (`outlineOptionVariants`, `showTargetVariants`). A third copy is not acceptable — extract one shared shrinking-variants helper into `ast/tools/render.ts` as part of this task.

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
- `surface` filters: `public` (visibility public + exported where the language has exports), `private` (inverse), `sourceExport` (`exported === true`), `packageSurface` (via adapter `resolvePackageSurface` capability — **not** language branches in the query/tool), `all`.
- Package/re-export rules live on the adapter (v1: TS/TSX Node package.json + cheap re-export walk in `languages/typescript-package-surface.ts`). Discover only consumes `PackageSurfaceGraph`. New language = new resolver on that adapter. No "unknown" strings.

## Output

Per `output-density.md`: group by defining file, path header once; each candidate `L<start>-<end>`, kind, signature slice; import/access path only when `packageSurface`/`sourceExport` made it the point. No scores, no work counters unless a budget tripped (one footer line). Complete-block bounding + temp overflow. Empty → one line.

## Done when

After `/reload`, call the real `discover` tool (harness, not a script) per [`../LIVE-PROVE.md`](../LIVE-PROVE.md):

- Each query kind (`exactName`, `prefixName`, `substringName`, `fuzzyName`, `declarationKind`, `documentation`) on corpus scopes.
- Languages: at least `pi` or `excalidraw` (TS/TSX), `go-tui`, `ast-bro`, `Avalonia`, `guava`, `okio`, `swift-collections`, `Odin` — narrow scopes from LIVE-PROVE.
- Surfaces: `public`, `private`, `sourceExport`; `packageSurface` on a TS package with resolvable entry (`pi` / this monorepo).
- Directory-only validation (file path → error); `resultLimit` footer when cut.
