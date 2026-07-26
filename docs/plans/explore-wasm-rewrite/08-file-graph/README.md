# Task 08 — File dependency graph, `deps` and `reverse_deps`

## Goal

Session file-import graph plus the two file-scoped tools. Staged. This graph also backs `impact` sections 2/4/5 (task 10).

Specs: `explore-specs/graph/deps.md`, `explore-specs/graph/reverse-deps.md`, `explore-specs/cross/system.md` (shared cache).

## Files

```text
packages/agent/extensions/explore/ast/graph/file-graph.ts
packages/agent/extensions/explore/ast/tools/deps.ts
packages/agent/extensions/explore/ast/tools/reverse-deps.ts
```

## Resolution (TS/TSX v1 — the only `fileDeps: true` adapters)

`FileIr.imports` specifiers resolve to files:

- Relative specifiers: try exact, then `.ts`, `.tsx`, then `/index.ts`, `/index.tsx`. Honor extensionless and `.js`→`.ts` rewrite (NodeNext style) since this repo uses it.
- Bare specifiers (packages): keep as external edges labeled by specifier; do not walk into `node_modules`.
- No tsconfig `paths` support v1 — if a specifier does not resolve, record it as unresolved; do not guess.

Languages without `fileDeps` → the tools return the capability-unavailable error named in `system.md`. Honest, not fake.

## Graph cache

`file-graph.ts` holds forward edges per file (built lazily from engine IR) and a reverse index built per scope scan on first `reverse_deps`/`impact` need, cached for the session, invalidated per path on the mutation bus (same invalidation hook as engine cache, wired task 13). `deps` with `depth > 1` is BFS over forward edges with cycle guard.

## Output

Per spec: dependent files as a small indented tree when factoring helps, depth labels when `depth > 1`, external package edges grouped last, one-line empty, omission footer only when `resultLimit` cut. No stats, no timing.

## Tests

Fixture tree with relative/index/bare/unresolved imports; depth BFS with a cycle; reverse index correctness; invalidation after simulated mutation; capability error for Go file.
