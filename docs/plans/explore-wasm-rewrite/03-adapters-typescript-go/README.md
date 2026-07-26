# Task 03 — Adapters: TypeScript, TSX, Go + fixture harness

## Goal

Two structurally different language families through the adapter interface, proving the IR carries what every later task needs. Plus the reusable fixture harness all other adapters use.

## Files

```text
packages/agent/extensions/explore/ast/languages/typescript.ts   (also exports the tsx adapter: same extractor, different wasm + id)
packages/agent/extensions/explore/ast/languages/go.ts
packages/agent/extensions/explore/ast/languages/harness.test-util.ts
packages/agent/extensions/explore/ast/languages/fixtures/<lang>/*.{ts,tsx,go} + *.expected.json
```

Register both in `registry.ts` (a language is one file plus one registry line — keep it that way).

## Extraction approach

Walk the tree with `tree.rootNode` / `namedChildren` in TS code; use `new Parser.Query(...)` only where it is genuinely shorter. Each adapter owns its node-type string constants. Doc comments: collect contiguous leading comment siblings (`//`-runs or one block comment) separated from the decl by ≤ 1 blank line; store the byte span only.

**Signature is a byte slice**: decl start (excluding doc span) to body-open brace / `=>` body start. Never rebuild signatures from parts — this rule is the whole point of the rewrite (see `explore-review-rok.md` indictment 2).

## TypeScript/TSX specifics

- Top-level: `function_declaration`, `class_declaration`, `abstract_class_declaration`, `interface_declaration`, `type_alias_declaration`, `enum_declaration`, `lexical_declaration`/`variable_declaration` (one `Decl` per declarator), `module`/`namespace` declarations (nest children).
- Unwrap `export_statement` wrappers; set `exported`. Handle `export default` (named and anonymous — anonymous default gets name `default`).
- Class members: `method_definition`, `public_field_definition`, accessors; visibility from modifiers, default `public`. `#private` names → `private`.
- Imports: `import_statement` source strings into `FileIr.imports`.
- Capabilities: `{ shape: true, search: true, fileDeps: true, callEdges: true, packageSurface: true }`.

## Go specifics

- `function_declaration`; `method_declaration` → `qualifiedName` = `Receiver.Method` (strip pointer `*`); `type_declaration`/`type_spec`: struct type → `struct`, interface type → `interface`, all other type specs (aliases, defined types over primitives) → `struct` (closest kind in the shared vocabulary; do not extend the vocabulary for aliases); `const_declaration` → `constant`, `var_declaration` → `variable`, one `Decl` per spec entry.
- Kind mappings must stay inside the shared `DeclKind` vocabulary. TS `type_alias_declaration` → `interface`. Record every such judgment call in the fixture expected files so it is reviewable, not folklore.
- `exported` = first rune uppercase; `visibility` = `public`/`private` accordingly.
- Imports: `import_spec` paths.
- Capabilities: `{ shape: true, search: true, fileDeps: false, callEdges: true, packageSurface: false }` — honest subsets are allowed by `explore-specs/cross/system.md`; do not fake package resolution.

## Fixture harness

`harness.test-util.ts`: given fixture source path, run engine `irForFile`, strip volatile fields (`contentHash`, absolute path), compare against `*.expected.json`. Expected files are committed, human-reviewed JSON — not auto-blessed snapshots. Fixtures must cover: nesting, docs, export/visibility variants, a file with a deliberate syntax error (assert `parseDegraded: true` and that surrounding decls still extract).
