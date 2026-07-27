# Task 08 — File dependency graph, `deps` and `reverse_deps`

## Cold start

Fresh window: read [`../COLD-START.md`](../COLD-START.md), [`../LIVE-PROVE.md`](../LIVE-PROVE.md), this file, deps/reverse-deps specs + system cache section, then `FileIr.imports` + TS adapter. **No new tests.** Register tools. Live per Done when. `check:ts` green.

Depends on: 03.

## Goal

Session file-import graph plus the two file-scoped tools. Register when they work. This graph also backs `impact` sections 2/4/5 (task 10).

Specs: `explore-specs/graph/deps.md`, `explore-specs/graph/reverse-deps.md`, `explore-specs/cross/system.md` (shared cache).

## Files

```text
packages/agent/extensions/explore/ast/graph/file-graph.ts
packages/agent/extensions/explore/ast/tools/deps.ts
packages/agent/extensions/explore/ast/tools/reverse-deps.ts
```

## Resolution (capability on adapter — not in the tool)

`fileDeps` resolution is **adapter-owned**. v1 only TS/TSX adapters set `fileDeps: true` and supply the resolve rules (relative + extensionless + `.js`→`.ts`, bare specs as external, no `node_modules` walk, no tsconfig paths). Shared `file-graph.ts` / tools call the capability; they must not hardcode TS extensions or Node package layout.

Languages without `fileDeps` → capability-unavailable error per `system.md`. Honest, not fake.

## Graph cache

`file-graph.ts` holds forward edges per file (built lazily from engine IR) and a reverse index built per scope scan on first `reverse_deps`/`impact` need, cached for the session, invalidated per path on the mutation bus (same invalidation hook as engine cache, wired task 13). `deps` with `depth > 1` is BFS over forward edges with cycle guard.

## Output

Per spec: dependent files as a small indented tree when factoring helps, depth labels when `depth > 1`, external package edges grouped last, one-line empty, omission footer only when `resultLimit` cut. No stats, no timing.

## Done when

After `/reload`, real `deps` / `reverse_deps` tools per [`../LIVE-PROVE.md`](../LIVE-PROVE.md):

- TS module graph on `pi` and/or `excalidraw` (narrow package scope), plus this monorepo optional.
- Depth BFS (`depth > 1`) on a known hub file.
- Non-`fileDeps` language path (e.g. `go-tui` file) → clear capability error, not fake edges.
