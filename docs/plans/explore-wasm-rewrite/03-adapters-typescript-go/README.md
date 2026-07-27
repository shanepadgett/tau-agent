# Task 03 — Adapters: TypeScript, TSX, Go

## Cold start

Fresh window: read [`../COLD-START.md`](../COLD-START.md), this file, then `ast/ir.ts` `ast/adapter.ts` `ast/engine.ts` `ast/registry.ts` on disk. **No new tests.** Live: IR dump on real `.ts` and `.go` in-repo. `check:ts` green.

Depends on: 02.

## Goal

Two structurally different language families through the adapter interface, proving the IR carries what every later task needs.

## Files

```text
packages/agent/extensions/explore/ast/languages/typescript.ts   (also exports the tsx adapter: same extractor, different wasm + id)
packages/agent/extensions/explore/ast/languages/go.ts
```

Register both in `registry.ts` (a language is one file plus one registry line — keep it that way).

Optional hand fixtures under `ast/languages/fixtures/` for live poking — not a vitest harness requirement.

## Extraction approach

Walk the tree with `tree.rootNode` / `namedChildren` in TS code; use `new Parser.Query(...)` only where it is genuinely shorter. Each adapter owns its node-type string constants. Doc comments: collect contiguous leading comment siblings (`//`-runs or one block comment) separated from the decl by ≤ 1 blank line; store the byte span only.

**Signature is a byte slice**: decl start (excluding doc span) to body-open brace / `=>` body start. Never rebuild signatures from parts — this rule is the whole point of the rewrite (see `explore-review-rok.md` indictment 2).

## TypeScript/TSX specifics

- Top-level: `function_declaration`, `class_declaration`, `abstract_class_declaration`, `interface_declaration`, `type_alias_declaration`, `enum_declaration`, `lexical_declaration`/`variable_declaration` (one `Decl` per declarator), `module`/`namespace` declarations (nest children).
- Unwrap `export_statement` wrappers; set `exported`. Handle `export default` (named and anonymous — anonymous default gets name `default`).
- Class members: `method_definition`, `public_field_definition`, accessors; visibility from modifiers, default `public`. `#private` names → `private`.
- Imports: `import_statement` source strings into `FileIr.imports`.
- Capabilities: `{ shape: true, search: true, fileDeps: true, callEdges: true, packageSurface: true }`. `resolveFileDep` lands in task 08 (hook required once graph tools ship).

## Go specifics

- `function_declaration`; `method_declaration` → `qualifiedName` = `Receiver.Method` (strip pointer `*`); `type_declaration`/`type_spec`: struct type → `struct`, interface type → `interface`, all other type specs (aliases, defined types over primitives) → `struct` (closest kind in the shared vocabulary; do not extend the vocabulary for aliases); `const_declaration` → `constant`, `var_declaration` → `variable`, one `Decl` per spec entry.
- Kind mappings must stay inside the shared `DeclKind` vocabulary. TS `type_alias_declaration` → `interface`. Record judgment calls in a short comment in the adapter file.
- `exported` = first rune uppercase; `visibility` = `public`/`private` accordingly.
- Imports: `import_spec` paths.
- Capabilities after task 03 extract: `{ shape: true, search: true, fileDeps: true, callEdges: true, packageSurface: false }`. Import strings land here; **`resolveFileDep` implementation is task 08** (must not stay a permanent capability gap). `packageSurface: false` is honest — Go has no package.json-style surface in v1.

## Done when

Live IR (or `outline` once task 06 exists) on corpus + monorepo per [`../LIVE-PROVE.md`](../LIVE-PROVE.md): real `.ts` from `pi`/`excalidraw` and `.go` from `go-tui` show nested decls, docs spans, exports/visibility, imports. Deliberate syntax error still yields surrounding decls + `parseDegraded: true`. Signatures are exact source slices.
