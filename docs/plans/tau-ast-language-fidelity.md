# Tau AST Language Fidelity Worklist

Status: active
Updated: 2026-07-24
Current language: Kotlin

## Purpose

Bring every supported `outline` and `symbol` language up to the TypeScript workflow's fidelity. Work one language at a time. Keep this file current when implementation, tool trials, or real repositories expose new gaps.

Reference repositories are read-only. Fixtures belong in Tau. A language is finished only after its adapter passes focused tests and a live tool-driven edit/revert trial against real source without `read`, `grep`, or shell source extraction.

## Reference coverage

| Language | Reference or selected candidate | Coverage state |
| --- | --- | --- |
| TypeScript | `ast-bro`, `codex` | Covered |
| TSX | `excalidraw` | Covered |
| Go | `go-tui` | Covered |
| Rust | `ast-bro`, `codex` | Covered |
| C# | `Avalonia` | Covered |
| Java | `guava` | Covered |
| Kotlin | `okio` | Covered |
| Swift | `swift-collections` | Covered |
| Odin | `Odin` | Covered |

Incidental files in a repository do not make it a useful language trial. For example, one Swift file in `go-tui` is not a substitute for `swift-collections`.

## Reference locations

- `ast-bro`: `/Users/shanepadgett/.local/share/tau-agent/references/ast-bro`
- `codex`: `/Users/shanepadgett/.local/share/tau-agent/references/codex`
- `go-tui`: `/Users/shanepadgett/.local/share/tau-agent/references/go-tui`
- `guava`: `/Users/shanepadgett/.local/share/tau-agent/references/guava`
- `okio`: `/Users/shanepadgett/.local/share/tau-agent/references/okio`
- `swift-collections`: `/Users/shanepadgett/.local/share/tau-agent/references/swift-collections`
- `Avalonia`: `/Users/shanepadgett/.local/share/tau-agent/references/Avalonia`
- `excalidraw`: `/Users/shanepadgett/.local/share/tau-agent/references/excalidraw`
- `Odin`: `/Users/shanepadgett/.local/share/tau-agent/references/Odin`

## Added reference choices

### TSX: Excalidraw

Repository: <https://github.com/excalidraw/excalidraw>

Local reference: `/Users/shanepadgett/.local/share/tau-agent/references/excalidraw`

Excalidraw is the primary TSX choice. It is MIT licensed, actively maintained, and mostly TypeScript. Its component source covers typed destructured props, hooks, fragments, conditional JSX, spread attributes, member-expression tags, type-only imports, path aliases, re-exports, callbacks, and side-effect style imports. Large files such as `App.tsx` also provide useful range and output-boundary stress.

Primary trial root: `packages/excalidraw/components`. Avoid letting the largest component dominate routine benchmarks.

Alternatives:

- `shadcn-ui/ui` for dense reusable component signatures, with the drawback of repeated registry templates.
- `calcom/cal.diy` for broad application and Next.js patterns, with the drawback of a very large monorepo.

### C\#: Avalonia

Repository: <https://github.com/AvaloniaUI/Avalonia>

Local reference: `/Users/shanepadgett/.local/share/tau-agent/references/Avalonia`

Avalonia is the primary C# choice. It is MIT licensed, actively maintained, and overwhelmingly C#. Framework source exercises namespaces and usings, attributes, nullable types, generic overloads, events, indexers, explicit interface implementations, expression-bodied members, and the less convenient visibility combinations that a direct adapter must get right.

Primary trial root: `src/Avalonia.Base`. XAML, native platform code, and source-generator infrastructure remain secondary evidence.

Alternatives:

- `jellyfin/jellyfin` for application-style controllers, records, dependency injection, and modern file-scoped namespaces.
- `dotnet/roslyn` for maximum language-edge coverage, with the drawback of a very large clone and substantial generated/test-fixture noise.

### Odin: Odin

Repository: <https://github.com/odin-lang/Odin>

Local reference: `/Users/shanepadgett/.local/share/tau-agent/references/Odin`

The Odin repository is the primary Odin choice. It uses the Zlib license, is actively maintained, and contains a large body of real Odin in `core`, `base`, examples, and tests. Those roots cover imports, procedures, default parameters, multiple returns, attributes, directives, distinct types, structs, enums, unions, procedure groups, polymorphism, `using`, foreign blocks, and type switches.

Primary trial roots: `core` and `base`. Avoid treating the C++ compiler implementation, vendor bindings, and generated tables as Odin adapter evidence.

Alternatives:

- `DanielGavin/ols` for a smaller, mostly Odin language-server corpus.
- `robbieawest/eno` for game-engine and callback-heavy source, with the drawback of a large asset footprint and smaller codebase.

## Working rules

- Keep one language active.
- Preserve the existing generic extractor until its replacement passes the language exit check.
- Add a direct Tau-owned adapter instead of growing language conditionals in one generic adapter.
- Extract shared code only after two adapters prove the duplication is mechanical.
- Keep declaration text exact. Signature text may omit implementations and must never be treated as replacement source.
- Keep body ranges internal for future body replacement. Agents retrieve the complete declaration before editing.
- Record real-repository failures here before fixing them.
- Rebuild the release worker and use `/reload` before every final live trial.
- Do not start the next language while the active language has an unexplained omission, wrong range, misleading signature, or visibility error.

## Definition of done for each language

- [ ] Route the language through a dedicated native adapter.
- [ ] Extract every supported top-level declaration and relevant member kind.
- [ ] Preserve attached documentation, annotations, attributes, modifiers, generics, constraints, and return types.
- [ ] Produce readable signatures without implementation bodies.
- [ ] Record exact declaration, name, and internal body ranges.
- [ ] Build stable qualified names for nested declarations and members.
- [ ] Apply language-correct public, private, package, and scoped visibility.
- [ ] Render imports, declarations, exports, and top-level executable structure in useful source order.
- [ ] Keep only import declarations used by `declarationWithImports`.
- [ ] Mark declaration certainty when parser recovery intersects or threatens ownership.
- [ ] Keep all visible members when a container name matches; keep only matching members for a member-name query.
- [ ] Support exact `signature`, `declaration`, and `declarationWithImports` symbol views where the language permits them.
- [ ] Add exact-range fixtures for multiline syntax, UTF-8, CRLF, malformed source, visibility, nesting, and language-specific declarations.
- [ ] Add worker protocol and model-output regression tests.
- [ ] Trial representative public and private APIs in the real reference repository.
- [ ] Use `outline → symbol(declaration) → patch → outline → symbol(declaration) → revert` on a previously unread real file.
- [ ] Confirm the reverted file has its original declaration and no remaining diff.
- [ ] Record accepted limitations explicitly.

## Shared work

- [x] Locator version 2 carries declaration, name, body, certainty, language, path, and fingerprint metadata.
- [x] `symbol(view="declaration")` returns exact contiguous source.
- [x] Public body-only retrieval removed; declaration retrieval is the editing baseline.
- [x] TypeScript container rendering keeps member locators without duplicating member contracts.
- [x] TypeScript edit/revert trial completed without `read`.
- [ ] Group multi-file symbol call targets by file instead of repeating `name@file` for every locator.
- [ ] Print each file heading once in expanded multi-file symbol results.
- [ ] Decide whether repeated outlines of the same declaration should reuse one numeric locator.
- [x] Move byte-range and parser-certainty mechanics shared by direct adapters into `source.rs`.
- [x] Add Avalonia and the focused Odin repository roots as read-only references.
- [x] Add Excalidraw as the real TSX reference.
- [x] Make attached documentation opt-in for completed direct adapters while keeping annotations, attributes, and exact declaration ranges.

## TypeScript and TSX baseline

References: Tau fixtures, `ast-bro`, `codex`, `excalidraw`

- [x] Dedicated TypeScript and TSX adapter.
- [x] Source-order imports, declarations, exports, and side effects.
- [x] Complete functions, overloads, classes, interfaces, type aliases, callable variables, decorators, and JSDoc.
- [x] Exact declaration, name, and body ranges with parser certainty.
- [x] Signature, declaration, and declaration-with-imports views.
- [x] Public and member-name filtering.
- [x] Live declaration edit/revert trial without `read`.
- [ ] Exercise the adapter against a substantial real TSX repository.
- [ ] Cover namespaces, merged declarations, enums, accessors, construct signatures, call signatures, and index signatures in the live trial.
- [ ] Resolve any defects discovered while other adapters reuse the common model.

## Go

Status: complete
Reference: `/Users/shanepadgett/.local/share/tau-agent/references/go-tui`

- [x] Inventory representative packages and choose unread trial files.
- [x] Add `go.rs` direct adapter and route Go through it.
- [x] Cover package clauses, import blocks, aliases, blank imports, and dot imports.
- [x] Cover grouped and single `const`, `var`, and `type` declarations.
- [x] Cover functions, methods, pointer/value receivers, generic parameters, structs, interfaces, embedded fields, and embedded constraints.
- [x] Use Go's uppercase identifier rule for exported declarations, fields, and methods.
- [x] Preserve doc comments and complete multiline signatures.
- [x] Record exact receiver, name, declaration, and body ranges.
- [x] Label `init` and top-level initialization behavior without returning implementation bodies in outlines.
- [x] Implement declaration-with-imports for normal, aliased, dot, and blank imports without rewriting import blocks.
- [x] Add fixture and worker tests.
- [x] Trial several `go-tui` packages, including tests and files with dense method sets.
- [x] Complete the unread edit/revert exit check.

Representative trials: `app.go`, `app_events.go`, `buffer.go`, `app_inline_test.go`, `cmd/tui/testdata/complex_gsx.go`, and `cmd/tui/integration_test.go`. All parsed without recovery. The unread edit/revert trial on `watcher_collect.go` restored the original declaration and left no diff.

Accepted Go limitations:

- An unaliased import's package name can differ from its path. Without package metadata, declaration-with-imports keeps unaliased imports conservatively. Aliased imports are still filtered by lexical use; dot and blank imports remain because their effect cannot be assigned to one identifier.
- Every item in a grouped `const`, `var`, or `type` declaration retrieves the exact enclosing group. Name ranges and signatures remain item-specific.
- A variable initializer with one function literal records that body range. Initializers with several function literals redact every body but leave the single-body range unset because the locator model carries one body range.

## Rust

Status: complete
References:

- `/Users/shanepadgett/.local/share/tau-agent/references/ast-bro`
- `/Users/shanepadgett/.local/share/tau-agent/references/codex`

- [x] Add `rust.rs` direct adapter and route Rust through it.
- [x] Cover modules, `use` trees, aliases, glob imports, and `extern crate`.
- [x] Cover functions, structs, tuple/unit structs, enums, unions, traits, type aliases, constants, statics, and associated items.
- [x] Treat inherent and trait `impl` blocks as qualified containers rather than anonymous objects.
- [x] Preserve attributes, doc comments, generics, `where` clauses, lifetimes, `async`, `const`, `unsafe`, and `extern` modifiers.
- [x] Distinguish `pub`, restricted `pub(...)`, crate-visible, and private declarations.
- [x] Handle trait declarations separately from default method implementations.
- [x] Define and test the supported boundary for macro declarations and macro-generated items.
- [x] Implement declaration-with-imports for nested `use` trees.
- [x] Add fixture and worker tests.
- [x] Trial both reference repositories.
- [x] Complete the unread edit/revert exit check.

Representative trials: `ast-bro/src/adapters/rust.rs`, `ast-bro/src/surface/imports.rs`, `codex-rs/agent-identity/src/lib.rs`, `codex-rs/app-server/src/config_manager.rs`, and the previously unread `codex-rs/rollout-trace/src/reducer/code_cell.rs`. All parsed without recovery.

Accepted Rust limitations:

- Trait imports can be used only through method resolution, with no lexical reference to the trait name. Declaration-with-imports conservatively keeps unreferenced uppercase bindings and glob imports so required traits are not dropped.
- Macro invocations remain side-effect rows. Tau cannot infer declarations generated by expanding them.
- Public reexports from a private inline module expose the reexported declaration under that module container so it retains an exact locator.

## Java

Status: complete
Reference: `/Users/shanepadgett/.local/share/tau-agent/references/guava`

- [x] Add `java.rs` direct adapter and route Java through it.
- [x] Cover package and import declarations, including static and wildcard imports.
- [x] Cover classes, interfaces, records, enums, annotation types, constructors, methods, fields, initializers, and nested types.
- [x] Preserve annotations, Javadoc, generic bounds, `throws`, modifiers, and multiline declarations.
- [x] Apply top-level, package, protected, private, nested, and implicit interface visibility correctly.
- [x] Keep enum constants and record components individually locatable.
- [x] Distinguish declarations from static and instance initializer blocks.
- [x] Implement declaration-with-imports without pretending wildcard provenance is exact.
- [x] Add fixture and worker tests.
- [x] Trial representative Guava packages and complete the unread edit/revert exit check.

Accepted Java limitations:

- The bundled Java grammar reports two recovery nodes for a valid doubly type-annotated varargs parameter such as `@Nullable Object @Nullable ... args`. Tau preserves the complete declaration and marks its owner and method as recovered. Guava's `Verify.java` contains two such parameters and therefore reports four recovery nodes.

## Kotlin

Status: active
Reference: `/Users/shanepadgett/.local/share/tau-agent/references/okio`

- [ ] Add `kotlin.rs` direct adapter and route Kotlin through it.
- [ ] Cover package/import declarations and import aliases.
- [ ] Cover top-level functions and properties, classes, data/value/sealed classes, interfaces, enums, objects, companions, and type aliases.
- [ ] Cover primary and secondary constructors, properties, accessors, methods, extension functions, and extension properties.
- [ ] Preserve KDoc, annotations, use-site targets, generics, constraints, modifiers, default values, and expression bodies.
- [ ] Apply Kotlin's default-public, `internal`, protected, and private visibility correctly.
- [ ] Distinguish expression bodies from signatures with a clear omission marker.
- [ ] Implement declaration-with-imports for normal, wildcard, and aliased imports.
- [ ] Add fixture and worker tests.
- [ ] Trial common, JVM, native, and test source sets in Okio and complete the unread edit/revert exit check.

## Swift

Status: queued
Reference: `/Users/shanepadgett/.local/share/tau-agent/references/swift-collections`

- [ ] Add `swift.rs` direct adapter and route Swift through it.
- [ ] Cover imports, type aliases, functions, structs, classes, actors, protocols, enums, and extensions.
- [ ] Cover properties, methods, initializers, deinitializers, subscripts, operators, enum cases, and associated types.
- [ ] Preserve documentation comments, attributes, generic constraints, `where` clauses, ownership modifiers, and concurrency modifiers.
- [ ] Apply `open`, `public`, `package`, `internal`, `fileprivate`, and `private` visibility correctly.
- [ ] Merge no declarations implicitly; keep extensions separately qualified and locatable.
- [ ] Define import retention for module imports, selective imports, and implementation-only imports.
- [ ] Add fixture and worker tests.
- [ ] Trial core collection implementations, extensions, and tests in Swift Collections.
- [ ] Complete the unread edit/revert exit check.

## C\#

Status: queued

- [x] Select Avalonia as the primary real C# repository.
- [x] Add Avalonia as a read-only reference.
- [ ] Add `csharp.rs` direct adapter and route C# through it.
- [ ] Cover using directives, aliases, global usings, and block/file-scoped namespaces.
- [ ] Cover classes, structs, interfaces, records, enums, delegates, constructors, methods, fields, properties, events, indexers, and operators.
- [ ] Preserve XML documentation, attributes, generics, constraints, modifiers, nullable syntax, and expression bodies.
- [ ] Apply top-level, nested, member, `internal`, protected combinations, and default visibility correctly.
- [ ] Keep property and event accessors individually understandable without duplicating their container declaration.
- [ ] Handle partial declarations as separate exact declarations with shared qualified names.
- [ ] Implement declaration-with-imports for namespace and static imports.
- [ ] Add fixture and worker tests.
- [ ] Trial the selected repository and complete the unread edit/revert exit check.

## Odin

Status: queued

- [x] Select the Odin repository, focused on `core` and `base`, as the primary real Odin corpus.
- [x] Add Odin as a read-only reference.
- [ ] Add `odin.rs` direct adapter and replace the custom outline-rule path.
- [ ] Cover package/import declarations, foreign imports and blocks, constants, variables, type declarations, procedures, procedure groups, structs, unions, enums, and bit sets.
- [ ] Preserve documentation comments, tags, attributes, polymorphic parameters, calling conventions, and return tuples.
- [ ] Apply `@(private)` and package visibility rules consistently.
- [ ] Distinguish declarations, initialization expressions, and executable top-level constructs.
- [ ] Implement declaration-with-imports for normal and aliased imports.
- [ ] Add fixture and worker tests.
- [ ] Trial the selected repository and complete the unread edit/revert exit check.

## Discovery log

### 2026-07-24

- Supplied references cover substantial TypeScript, Go, Rust, Java, Kotlin, and Swift source.
- No supplied repository contains C# or Odin source.
- No supplied repository contains TSX source.
- Web research selected Avalonia for C#, the Odin repository's `core` and `base` roots for Odin, and Excalidraw for TSX.
- Avalonia, Excalidraw, and Odin are now available under the shared read-only reference directory and their canonical paths are recorded above.
- Roslyn, OLS, and shadcn-ui remain useful secondary edge-case corpora if primary trials leave meaningful syntax gaps.
- Generic non-TypeScript outlines currently retrieve exact declarations by locator, but signatures, name/body ranges, certainty, visibility, qualified names, and imports do not yet match the TypeScript adapter.
- Live TypeScript trial proved `outline → symbol(declaration) → patch → re-outline → revert` works without source reads.
- Multi-file symbol call and result rendering still repeats file names and belongs in shared cleanup.
- Go now uses a direct adapter with source-order package/import rows, exact declaration/name/receiver/body ranges, body-free signatures, grouped declarations, generic and embedded members, Go visibility, selective symbol views, and parser certainty.
- Real Go trials covered the root package, dense method files, generated-style source, and tests. All selected files parsed without recovery or unexplained omissions.
- Go import retention is exact for aliases and conservative for unaliased, dot, and blank imports because source syntax does not reveal arbitrary package-name/path mismatches.
- The Go exit trial completed `outline → symbol(declaration) → patch → outline → symbol(declaration) → revert` on the previously unread `watcher_collect.go`. A final outline and symbol returned the original declaration, and `git diff --exit-code` confirmed no remaining change.
- Rust now uses a direct adapter with source-order imports and exports, exact declaration/name/body ranges, qualified impl and nested-module members, restricted visibility, body-free signatures, selective symbol views, parser certainty, macro redaction, and conservative trait-import retention.
- Rust fixture, worker, renderer, UTF-8, CRLF, malformed-source, visibility, tuple-constraint, macro-delimiter, and nested-impl tests pass. Debug-worker trials across both Rust references parsed without recovery.
- The Rust exit trial completed `outline → symbol(declaration) → patch → outline → symbol(declaration) → revert` on the previously unread `codex-rs/rollout-trace/src/reducer/code_cell.rs`. The updated tools returned the edited declaration, then returned the original declaration after revert. `git diff --exit-code` confirmed no remaining change.
- Java now uses a direct adapter with source-order package/import rows, exact declaration/name/body ranges, qualified nested members, Java visibility defaults, body-free signatures, individually locatable enum constants and record components, initializer rows, selective symbol views, parser certainty, and conservative wildcard-import retention.
- Java fixture, worker, renderer, UTF-8, CRLF, malformed-source, visibility, varargs-record, enum-separator, and lambda-redaction tests pass.
- A filtered Guava `MediaType.create` outline retained imports used elsewhere in `MediaType` because Java import analysis used the owning class range for member-name matches. Java member filtering now analyzes only the retained member ranges; top-level matches still analyze the complete declaration.
- Guava's `Verify.java` exposed a bundled-parser limitation for doubly type-annotated varargs parameters. A minimal source reproduced two recovery nodes per parameter with no declaration omission or range loss.
- Java repository trials covered `Escapers.java`, `ImmutableList.java`, `Range.java`, `CaseFormat.java`, `MediaType.java`, `Service.java`, and `Verify.java`. The adapter preserved public and private APIs, nested classes and interfaces, enum constant bodies, overloads, annotations, multiline signatures, and selective imports.
- The Java exit trial completed `outline → symbol(declaration) → patch → outline → symbol(declaration) → revert` on the previously unread `Defaults.java`. The edited declaration and restored declaration both resolved exactly, and `git diff --exit-code` confirmed no remaining change.
- Completed TypeScript/TSX, Go, Rust, and Java adapters now omit attached documentation comments unless `includeDocs` is true. Annotations and attributes remain visible, and `symbol(declaration)` still returns the exact declaration including attached docs.
- Real-repository outlines with `includePrivate` saved 692 bytes (11.9%) in Excalidraw `Actions.tsx`, 4,144 bytes (55.0%) in go-tui `app.go`, 1,039 bytes (24.4%) in ast-bro `src/adapters/rust.rs`, and 27,077 bytes (66.5%) in Guava `MediaType.java` compared with documentation-enabled output.
