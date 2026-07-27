# Task 11 — `ast_search` (research gate inside)

**DONE 2026-07-27.** Option A (`@ast-grep/wasm@0.45.0` + pinned grammar wasm). See [`decision.md`](decision.md). Tool registered; corpus live-proved all nine search languages. Do not re-spike or re-implement unless bumping the matcher package.

## Cold start

Fresh window: read [`../COLD-START.md`](../COLD-START.md), [`../LIVE-PROVE.md`](../LIVE-PROVE.md), this file, `explore-specs/shape/ast-search.md`, engine parse path. **No new tests.** Spike → `decision.md` in this folder → implement. Can trail critical path. Live patterns after register. `check:ts` green.

Depends on: 02 (+ adapters for languages you claim).

## Goal

Structural pattern search per `explore-specs/shape/ast-search.md`. The spec says ast-grep patterns; ast-grep's Node binding is a **native addon and therefore banned**. This task starts with a time-boxed research spike and a decision.

Can trail the critical path — product usable without it after outline/show/graph.

## Step 1 — spike (max ~1 day, outcome written to `decision.md` in this folder)

Option A: **ast-grep compiled to WASM.** ast-grep's web playground runs its matcher in WASM, so the core crates compile to `wasm32`. Investigate a small wrapper crate exporting `findMatches(source, pattern)` via `wasm-bindgen` as a committed artifact (WASM, not Mach-O, so policy-compatible). Hard gate: it must consume our nine **pinned grammar `.wasm` files** at runtime. If it needs grammars compiled in as Rust crates (likely), that doubles every grammar pin and adds a Rust toolchain to the offline container build from task 01 — that violates decision 9's spirit ("prebuilt beats rebuilt") and disqualifies A. Do not spend the spike making A work; spend it confirming whether the gate holds.

Option B: **in-house matcher over tree-sitter.** Parse the pattern with the target grammar (wrapping candidates for expression/statement contexts until one parses cleanly), then structural tree match where `$NAME` binds one named node and `$$$NAME` binds a sibling sequence. Scope v1 to: single-node patterns, metavariables, sequence metavariables in argument/statement lists.

Decision rule: A only if the spike proves it loads our pinned grammar wasm without a new grammar pipeline. Otherwise (expected) Option B with the scoped semantics, documented as such in the tool description.

## Step 2 — implementation

```text
packages/agent/extensions/explore/ast/queries/ast-search.ts
packages/agent/extensions/explore/ast/format/ast-search.ts
packages/agent/extensions/explore/ast/tools/ast-search.ts
```

- Params per spec: `path`, `pattern` (1…16 KiB), `language` (required for directories; must match file extension when both given), `resultLimit` 1–100.
- Directory walks via `scan.ts` budgets. Matching needs live trees, and **the engine owns all parser/grammar lifecycle** — do not construct `Parser`/`Language` outside `engine.ts`. Task 09 did **not** add an occurrence/tree seam (call sites live on IR at extract time). For ast_search, add an engine-owned scoped parse helper here — e.g. `withFileTree(path, fn)` / sibling — that parse → `fn(tree, source)` → `tree.delete()` in `finally`. Do not route through the IR cache (IR has no tree), do not cache match results, and do not invent `collectOccurrences` for this tool.
- Pattern parsing uses the same engine seam with the pattern text as a virtual source. Metavariable syntax handling lives in shared query code; anything grammar-node-specific (wrapping candidates per language) lives on the adapter or in a per-language table under `ast/languages/` — not in shared match code (COLD-START rule 2).
- Output per spec: per-file groups, line ranges, exact previews, metavariable bindings with exact text, enclosing scope name only when disambiguating (resolve via that file's IR). Empty → success + one line. No pattern echo.

## Done when

`decision.md` exists; tool registered. After `/reload`, real `ast_search` per [`../LIVE-PROVE.md`](../LIVE-PROVE.md):

- Patterns on `pi`/`excalidraw` (TS/TSX) and `go-tui` when claimed: plain, `$NAME`, `$$$ARGS`, no-match.
- Language errors and budget trip on corpus scopes.
- Any extra claimed language hits its corpus row once.
