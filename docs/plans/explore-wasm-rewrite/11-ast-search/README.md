# Task 11 — `ast_search` (research gate inside)

## Cold start

Fresh window: read [`../COLD-START.md`](../COLD-START.md), [`../LIVE-PROVE.md`](../LIVE-PROVE.md), this file, `explore-specs/shape/ast-search.md`, engine parse path. **No new tests.** Spike → `decision.md` in this folder → implement. Can trail critical path. Live patterns after register. `check:ts` green.

Depends on: 02 (+ adapters for languages you claim).

## Goal

Structural pattern search per `explore-specs/shape/ast-search.md`. The spec says ast-grep patterns; ast-grep's Node binding is a **native addon and therefore banned**. This task starts with a time-boxed research spike and a decision.

Can trail the critical path — product usable without it after outline/show/graph.

## Step 1 — spike (max ~1 day, outcome written to `decision.md` in this folder)

Option A: **ast-grep compiled to WASM.** ast-grep's web playground runs its matcher in WASM, so the core crates compile to `wasm32`. Investigate building a small wrapper crate exporting `findMatches(source, pattern, langWasm?)` via `wasm-bindgen`, compiled in the same CI pipeline as task 01 (CI-built, committed artifact — WASM, not a Mach-O, so policy-compatible). Key questions: can it consume our pinned grammar `.wasm` files or does it need grammars compiled in as Rust crates (likely the latter — which doubles grammar pinning); artifact size; maintenance cost.

Option B: **in-house matcher over tree-sitter.** Parse the pattern with the target grammar (wrapping candidates for expression/statement contexts until one parses cleanly), then structural tree match where `$NAME` binds one named node and `$$$NAME` binds a sibling sequence. Scope v1 to: single-node patterns, metavariables, sequence metavariables in argument/statement lists.

Decision rule: if Option A yields a working artifact in the spike window with our nine languages, take it. Otherwise Option B with the scoped semantics, documented as such in the tool description.

## Step 2 — implementation

```text
packages/agent/extensions/explore/ast/queries/ast-search.ts
packages/agent/extensions/explore/ast/format/ast-search.ts
packages/agent/extensions/explore/ast/tools/ast-search.ts
```

- Params per spec: `path`, `pattern` (1…16 KiB), `language` (required for directories; must match file extension when both given), `resultLimit` 1–100.
- Directory walks via `scan.ts` budgets. Matching needs live trees — for this tool, parse → match → `tree.delete()` per file; do not route through the IR cache (IR has no tree).
- Output per spec: per-file groups, line ranges, exact previews, metavariable bindings with exact text, enclosing scope name only when disambiguating (resolve via that file's IR). Empty → success + one line. No pattern echo.

## Done when

`decision.md` exists; tool registered. After `/reload`, real `ast_search` per [`../LIVE-PROVE.md`](../LIVE-PROVE.md):

- Patterns on `pi`/`excalidraw` (TS/TSX) and `go-tui` when claimed: plain, `$NAME`, `$$$ARGS`, no-match.
- Language errors and budget trip on corpus scopes.
- Any extra claimed language hits its corpus row once.
