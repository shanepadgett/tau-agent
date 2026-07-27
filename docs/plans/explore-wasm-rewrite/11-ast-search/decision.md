# Task 11 decision — `ast_search` matcher

**Date:** 2026-07-27  
**Choice: Option A — `@ast-grep/wasm` over our pinned grammar `.wasm` files.**

## Hard gate (from task README)

> A only if the spike proves it loads our pinned grammar wasm without a new grammar pipeline. Otherwise (expected) Option B.

Gate **holds**. Option B is not required.

## What was tested

Live Node spike (temp dir, not committed):

- `@ast-grep/wasm@0.45.0` + peer `web-tree-sitter@0.26.11` (same major/minor as monorepo pin)
- All **nine** Explore grammar artifacts via `registerDynamicLanguage({ id: { libraryPath, expandoChar: 'µ' } })`:
  - vscode package: typescript, tsx, go, rust, c_sharp, java
  - committed: kotlin, swift, odin (`ast/grammars/*.wasm`)
- Paths resolved exactly as `grammarWasmPath` / manifest already do
- `initializeTreeSitter()` works both before and after our engine-style `Parser.init({ locateFile })`
- After dual init, both IR-style parse and ast-grep `find` still work
- Artifact is pure WASM (`00 61 73 6d` magic), ~1.7 MiB `wasm_bg.wasm` — not Mach-O, policy-compatible
- Package declares **no** bundled language crates; languages are runtime-registered only

### Match smoke (with `expandoChar: 'µ'`)

| Lang | plain / `$` / `$$$` | Notes |
| --- | --- | --- |
| typescript | pass | bindings + `findAll` |
| tsx | pass | including `<$TAG $$$PROPS />` |
| go | mostly pass | bare `fmt.Println($A)` parses as `type_conversion_expression` (tree-sitter ambiguity); works with contextual pattern `{ context: 'func f() { … }', selector: 'call_expression' }`. Unqualified `foo($$$ARGS)` fine |
| rust | pass | `println!($A)`, `foo($$$ARGS)` |
| java | pass | |
| c_sharp | pass | |
| kotlin | pass | |
| swift | pass | |
| odin | pass | needs `µ` expando (default `$` → “Multiple AST nodes”) |

Empty find → `undefined` (treat as success + short empty message in the tool).

## Why not Option B

Gate for A passed. In-house matcher would reimplement ast-grep metavariables / strictness / multi-node `$$$` for less fidelity and more code. B remains a fallback only if A integration is blocked later (engine lifecycle, packaging, or ABI mismatch we cannot fix).

## Why this does not violate decision 9 / task 01

- **No second grammar pin set.** Same nine `.wasm` files already loaded for IR.
- **No Rust grammar crates.** No `tree-sitter-*` Rust deps, no doubling kotlin/swift/odin build.
- **No Rust toolchain on the task-01 offline grammar container.** Matcher is a prebuilt npm package (`publish`d as `@ast-grep/wasm`; playground crate is the upstream source).
- Runtime peer is the existing `web-tree-sitter` dependency.

## Implementation constraints (for step 2)

1. **Dependency:** add `@ast-grep/wasm` (pin exact version tested, currently `0.45.0`) next to `web-tree-sitter` on `packages/agent`. Do not add `@ast-grep/napi` (native).
2. **Expando:** register every grammar language with `expandoChar: 'µ'` (ast-grep’s usual identifier-safe expando). Default `$` breaks odin and weakens several others.
3. **Engine owns lifecycle** (adapt the Option-B-shaped note in the task README):
   - Engine performs `Parser.init` (existing) and `initializeTreeSitter` (once, idempotent with dual init).
   - Engine calls `registerDynamicLanguage` from **manifest paths only** (`grammarWasmPath`) when a language is first needed for search — tools/queries never touch `@ast-grep/wasm` load APIs or wasm paths.
   - Prefer an engine seam such as `searchInSource({ languageId, source, pattern })` / path helper that reads file + delegates; do **not** require IR cache, do **not** cache match results, do **not** invent `collectOccurrences`.
   - Trees created inside `@ast-grep/wasm` stay inside that stack; IR path still `parse → extract → tree.delete()`. No sharing of `Tree` objects across stacks.
4. **Language separation:** shared query code stays blind. Pattern **context wrap candidates** (needed at least for Go qualified calls like `fmt.Println($A)`) live on the adapter or a per-language table under `ast/languages/` — shared matcher tries wraps until one pattern compiles/matches cleanly. No `language ===` in tools/queries/format.
5. **Offsets:** `@ast-grep/wasm` `Pos.index` is **Unicode scalar (character) offset**, not UTF-16. Prefer `SgNode.text()` and line/col from `range()` for output. If slicing `source` by index, convert char offset → JS string index; do not assume IR UTF-16 indices.
6. **`$$$` bindings:** `getMultipleMatches` returns **all** child nodes including commas/punctuation. Format with exact text; do not invent pretty-join unless spec asks.
7. **Markdown:** `capabilities.search: false` (already). Directory/file search skips non-search languages.
8. **Tool surface:** params/output still per `explore-specs/shape/ast-search.md`. Tool description should teach `$NAME` / `$$$NAME` / `$_` by example (ast-bro lesson). Search only — no rewrite API exposed.
9. **Scoped v1 semantics:** full ast-grep string patterns (and engine-applied contextual wraps). Document in tool description that patterns follow ast-grep rules; Go-qualified calls may need wraps applied internally.

## Explicit non-choices

- Not building a private wasm-bindgen fork of `crates/wasm` unless npm package becomes unusable.
- Not committing a second copy of grammar wasm for ast-grep.
- Not using native `@ast-grep/napi` / `ast-grep-language` builtin parsers.
- Not implementing Option B in parallel.

## Done-when impact

After implement + register: live-prove plain / `$NAME` / `$$$ARGS` / no-match on TS/TSX and Go (and other claimed corpus langs), plus language errors and budget trips per task README + `LIVE-PROVE.md`.
