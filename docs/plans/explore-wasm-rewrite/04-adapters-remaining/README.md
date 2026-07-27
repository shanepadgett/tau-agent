# Task 04 — Adapters: Rust, C#, Java, Kotlin, Swift, Odin

## Cold start

Fresh window: read [`../COLD-START.md`](../COLD-START.md), [`../LIVE-PROVE.md`](../LIVE-PROVE.md), this file, task 03 adapters as template, `ast/adapter.ts` + registry. **No new tests.** Prefer after 06. Live per Done when. `check:ts` green.

**Language separation:** each language = adapter file under `ast/languages/` + one registry line (+ grammar pin). Do **not** edit tools/queries/format. Put `importNoiseIdentifiers` and any capability hooks on the adapter only.

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

## Guardrails from the outline checkpoint review

- Offsets: emit `node.startIndex`/`node.endIndex` directly (plan README decision 12). Never convert to bytes.
- Do not grow `NOISE_IDENTIFIERS` in `ast/queries/show.ts` with new-language keywords. That set is TS/Go leakage already; if import matching needs stop-words for a new language, stop and raise moving them onto the adapter instead.

## Done when

After `/reload`, real `outline` (preferred) or `show` on corpus scopes from [`../LIVE-PROVE.md`](../LIVE-PROVE.md) for **each** remaining language: Rust `ast-bro`, C# `Avalonia`, Java `guava`, Kotlin `okio`, Swift `swift-collections`, Odin `Odin`. External-scanner languages (Kotlin/Swift) must hit real corpus syntax once. `check:ts` green.
