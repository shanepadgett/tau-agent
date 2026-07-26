# Task 04 — Adapters: Rust, C#, Java, Kotlin, Swift, Odin

## Cold start

Fresh window: read [`../COLD-START.md`](../COLD-START.md), this file, task 03 adapters as template, `ast/adapter.ts` + registry. **No new tests.** Prefer after 06. Live: one real file per language. `check:ts` green.

Depends on: 03. Do not change engine/tools.

## Goal

Remaining six adapters through the same interface from task 03. One file + one registry line each. No engine or tool changes permitted in this task — if an adapter needs an IR change, stop and raise it.

**Prefer after task 06** so the outline/show spine is proven on TS/Go first. Do not block outline on bulk adapters.

## Per-language extraction notes

| Language | Notes |
| --- | --- |
| Rust | `function_item`, `struct_item`, `enum_item`, `trait_item`, `impl_item` (nest methods under the impl target's `qualifiedName`; inherent and trait impls both), `mod_item` nesting, `const_item`/`static_item`, `type_item`. Visibility from `visibility_modifier` (`pub`, `pub(crate)` → `internal`). Doc comments: `///` runs and `//!`. Attributes (`#[...]`) belong to the signature slice, not the doc span. |
| C# | `namespace_declaration` (+ file-scoped) nesting, `class/struct/record/interface/enum_declaration`, `method_declaration`, `property_declaration`, `field_declaration`, `constructor_declaration`, `event` decls. Default member visibility `private`, default type visibility `internal`. XML doc comments (`///`) as doc span. |
| Java | Types + members; annotations stay in signature slice. `enum_declaration` constants → `enumMember` children. Default (package-private) visibility → `internal`. Javadoc block as doc span. |
| Kotlin | Top-level functions/properties/classes/objects; `companion_object` children under owner; `internal` modifier maps directly; KDoc as doc span. Grammar node names differ from Java's — read `node-types.json` in the pinned grammar repo, do not guess. |
| Swift | `function_declaration`, `class/struct/enum/protocol_declaration`, `extension` (nest members under extended type's `qualifiedName`), computed properties, initializers → `constructor`. Access levels: `open`/`public` → `public`, `internal` (default) → `internal`, `fileprivate`/`private` → `private`. |
| Odin | `procedure` declarations (`name :: proc(...)`), struct/enum/union value declarations, constants. Package-level only; visibility `public` unless `@(private)` attribute. Grammar is younger — unknown node kinds skip extraction (`parseDegraded` untouched; missing extraction is not parser degradation). |

## Capabilities (initial, honest)

All six: `{ shape: true, search: true, fileDeps: false, callEdges: true, packageSurface: false }`. File-dep extraction beyond TS/TSX is future work behind the capability flag; tools already report capability gaps per `explore-specs/cross/system.md`.

## Done when

Live outline (or engine IR dump) on at least one real file per language available in-repo or a tiny hand fixture. Kotlin/Swift should hit external-scanner syntax once if fixtures exist. `check:ts` green.
