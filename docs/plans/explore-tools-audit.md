# Explore tools audit

Status: all eight languages swept — TypeScript (two corpora), Kotlin, Swift,
Rust, Go, C#, Java, and Odin.

Remediation plan: `docs/plans/explore-tools-remediation.md`. That document owns
the fix decisions. Note that Odin support is being removed rather than repaired,
so Findings 22, 23 and 24 are retired and recorded here for history only.

Full sweep of every explore tool against this repository (`tau-agent`), run after
the AST move to `packages/agent/src/ast/` and the fallow dedup pass. Findings
here drive one batched fix workload once the non-TypeScript corpora are cloned.

## Scope of what was exercised

All 12 tools, against TypeScript at scale plus the six single-file fixtures in
`packages/agent/src/ast/languages/fixtures/`:

- `outline` — file, non-recursive dir, recursive subtree, `includeDocs`,
  `includePrivate`, `names` filter, markdown heading trees.
- `show` — all four views; ambiguity and missing-name error paths.
- `discover` — exactName, prefixName, substringName, fuzzyName, declarationKind,
  documentation; `packageSurface` import-path output.
- `ast_search` — metavariables (`$NAME`, `$$$ARGS`), enclosing-function
  attribution, extension-inferred language.
- `deps` / `reverse_deps` — depth 1 and 2.
- `callers` / `callees` / `references` / `implementations` — including scope
  guards and same-name ambiguity.
- `impact` (both directions) and `context` (budgeted pack).
- Large-file read policy: full read of a 597-line file returned outline plus the
  ranged-read hint.

Verified working after the `createLeafBuilder` refactor: heritage `bases`
resolve correctly in C#, Java, Kotlin, and Swift — exact hits in the target's
own file, `ambiguous` with competitors across files.

## Finding 1 — workspace package specifiers unresolved (highest payoff)

`reverse_deps packages/agent/src/index.ts` reports `No reverse file
dependencies`, though `extensions/context/index.ts` and
`extensions/session-memory/index.ts` both import `@shanepadgett/tau-agent`.
`references` resolves the same specifier correctly, so the two tools disagree.

Root cause in `packages/agent/src/ast/languages/typescript-file-deps.ts`, the
tail of `resolveTypescriptFileDep`: relative specifiers resolve, tsconfig
`paths` aliases resolve, and everything else falls through to `externalId`. This
repo declares no `paths` mapping — workspace packages resolve through the
npm workspaces symlink in `node_modules`, which the resolver never consults.

Impact: `deps`, `reverse_deps`, and `impact` are blind at exactly the boundary
every extension now imports across, since internal code was switched to
package-root imports.

Recommended fix: before the `externalId` fallback, resolve against a
`name -> dir` map built from the root `package.json` `workspaces` globs,
memoized in `host.memo`. Resolve the matched package's entry with the
`types`/`module`/`main` logic that `typescript-package-surface.ts` already
implements. Roughly 40 lines. Deliberately avoids the `node_modules` symlink so
resolved paths stay inside the source tree and `host.ownsPath` keeps working
(a path containing `/node_modules/` would be rejected and would also duplicate
the real file).

Not TypeScript-specific as a class of bug: every language has its own resolver
with its own bare-specifier fallback. Check the others against their corpora.

## Finding 2 — module-level call sites have no owner

`callers createLeafBuilder` returns `No relationship sites` even though five
grammar adapters call it. `references` shows only the import lines.
`ast_search 'const leaf = createLeafBuilder($$$ARGS)'` finds all five.

Root cause: call extraction runs per declaration body (`walkBodyNodes` over each
decl), so a top-level statement such as
`const leaf = createLeafBuilder(extractCalls, heritageBases);` has no owning
declaration and produces no `CallSite` in the IR at all.

The dangerous part is not the missing rows, it is that the output reads as "no
callers" rather than "not tracked".

Recommended fix: give top-level calls an owner in the IR — either add
`fileCalls` to `ExtractResult` or emit one synthetic file-level decl per module.
Shared plumbing in `src/ast/ir.ts` and `src/ast/graph/relationships.ts`, plus a
one-line change per adapter (run `extractCalls` on the tree root; `walkBodyNodes`
already skips nested scopes).

Affects every language allowing top-level statements: TypeScript, Kotlin, Swift,
Rust, Odin, Go. Java and C# are immune by syntax.

## Finding 3 — vendored TypeScript grammar bug (recommend no action)

`parser: degraded on at least one file` appears on `packages/agent` scope but not
on `src/` or `extensions/`. Cause is four test files, all vitest mocks using
`importOriginal<typeof import("../../shared/settings/json.ts")>()`:

- `test/extensions/cache-diagnostics/index.test.ts`
- `test/extensions/image-gen/index.test.ts`
- `test/extensions/subagent/runtime.test.ts`
- `test/shared/settings-load.test.ts`

Minimal repro against the pinned grammar (`@vscode/tree-sitter-wasm` 0.3.1,
`web-tree-sitter` 0.26.11) — a `typeof import(...)` type query inside a call's
type arguments:

```text
ok    let a: typeof import("x");                        annotation form
ok    let b: import("x").Thing;
FAIL  f<typeof import("x")>();                          the failing construct
FAIL  const y = await f<typeof import("x")>();
ok    const c = { a: 1 } satisfies Record<string, number>;
ok    using d = getResource();
ok    class E { accessor f = 1; }
ok    function g<const T>(x: T) { return x; }
```

0.3.1 is the latest published version, so the only fix is pinning our own
`tree-sitter-typescript` build. The pipeline exists (`scripts/build-grammars.ts`,
already producing `kotlin.wasm`, `swift.wasm`, `odin.wasm`), but owning the
TypeScript grammar for a construct that appears only in test mocks is a bad
trade. Leave it. The `parser: degraded` warning is honest and sufficient.

## Finding 4 — `context` dependents include same-name noise

`context ScrollableMarkdown` listed `renderFilterRow` under `dependents`.
`src/ast/queries/context.ts` derives type dependents from callers of the type's
methods, matched by name, so a method as common as `render` in a TUI codebase
collects unrelated call sites.

Documented conservative behavior, not a defect. Cheap improvement: annotate
method-derived dependents with their certainty, or drop `ambiguous` ones.

## Finding 5 — Kotlin grammar rejects one-line class bodies (cosmetic)

Found while spot-checking the non-TypeScript adapters. Grammar pin
`fwcd/tree-sitter-kotlin` 0.3.8, built in-repo:

```text
FAIL  class Circle { fun draw() {} }
ok    class Circle {\n    fun draw() {}\n}
ok    interface Shape {\n    fun draw()\n}
ok    class Circle {}
```

The grammar wants a newline separator inside a non-empty class body. Idiomatic
Kotlin is multi-line, so real corpora should be unaffected — confirm against the
Kotlin corpus before dismissing.

## Method notes for the next pass

- Parse health per file comes from `engine.irForFile(path).parseDegraded`. A
  throwaway vitest file under `packages/agent/test/` is the quickest harness,
  since the engine is ESM TypeScript; write results to a file because vitest
  swallows `console.log`.
- Do not bisect parse failures by truncating file prefixes. Truncation leaves
  unbalanced braces and reports the wrong line. Parse the whole file and walk for
  `ERROR` / `isMissing` nodes instead.
- Grammar-level repros load `web-tree-sitter` directly with
  `runtimeWasmPath()` and `grammarWasmPath(pin)` from
  `src/ast/grammars/manifest.ts`.

## Pending

Real-world corpora per language, to be cloned locally and swept the same way.
Priorities per corpus: bare-specifier/module resolution in that language's
`*-file-deps.ts`, `parseDegraded` rate across the tree, top-level call
attribution, and heritage/implementation resolution at scale.

| Language | Corpus | Swept |
| --- | --- | --- |
| TypeScript | this repo and `references/pi` | yes |
| Kotlin | `references/athenacompose-android` | yes |
| Swift | `references/athenapatient-ios` | yes |
| Rust | `references/tokio` | yes |
| Go | `references/prometheus` | yes |
| Java | `references/micronaut-core` | yes |
| C# | `references/jellyfin` | yes |
| Odin | `references/Odin` | yes |

Harness scripts live in `/tmp/audit-harness/` between passes. They must not sit
under `packages/agent/test/` when a turn ends, or the automatic `check:ts` run
picks them up and fails on the missing `AUDIT_ROOT` environment variable.

## Kotlin pass — `references/athenacompose-android`

Corpus: 864 `.kt` files, ~76k LOC, multi-module Gradle (`app`, `common`,
`network`, `mobilertc`, `apollo-compiler-plugin`), Android layout with Kotlin
sources under `src/main/java/`, Compose-heavy. Full-tree parse took 653 ms for
864 files and 2,375 top-level declarations, so engine throughput is not a
concern.

### Finding 6 — JVM dep resolution fails across modules (severe)

`deps` on a `common` module file classified every `com.athenahealth.network.*`
import as **external**, and `reverse_deps` on a widely-imported `common`
interface returned `No reverse file dependencies`. Same-module class imports
resolved correctly (`base/State.kt`, `ui/LifecycleListener.kt`).

Three distinct defects in `src/ast/languages/jvm-file-deps.ts`, all confirmed:

1. **Module source roots are never discovered.** `sourceRootsFor` builds
   candidate roots from (a) every ancestor of the importing file's own directory
   and (b) `sourceRootSuffixes` joined onto `host.scopeRoot` — so it tries
   `<scopeRoot>/src/main/java`, never `<scopeRoot>/<module>/src/main/java`. An
   import of `com.athenahealth.network.manager.AuthManager` from a file in
   `common/` therefore never tests
   `network/src/main/java/com/athenahealth/network/manager/AuthManager.kt`, which
   does exist at exactly that package path. Every Gradle or Maven multi-module
   repository hits this, which is nearly all real Java and Kotlin code —
   `micronaut-core` will show the same shape.
   Fix: discover module source roots once per scope (directories matching
   `*/src/{main,commonMain,jvmMain}/{java,kotlin}` to a bounded depth), memoize
   in `host.memo`, and try them after the local roots.
2. **Kotlin top-level member imports are hard-coded external.** The
   `packageOnly` / `memberLike` branch in `createJvmFileDepResolver` returns
   `externalId` for any import whose last segment starts lowercase. In Kotlin
   that is idiomatic — every Composable, extension function, and top-level `val`.
   `com.athenahealth.common.controller.constant.biometricPrompt` resolved as
   external even though it is a top-level `fun` in
   `common/.../controller/constant/BiometricPrompt.kt` in the same module.
   Fix: for Kotlin, before falling back, try the member's *containing* package
   directory and match any file declaring that top-level name. Java can keep the
   current behavior since static member imports are qualified by type.
3. **Filename-equals-typename assumption.** `resolveTypeAgainstRoot` maps
   `com.foo.Bar` to `com/foo/Bar.kt`. Java enforces that; Kotlin does not, so
   multiple top-level types in one file, or a type in a differently named file,
   silently miss.

Ranking note: this outranks Finding 1. Same class of bug (bare specifier falls
through to external), but here it suppresses the majority of internal edges
rather than one package boundary.

### Finding 7 — `ast_search` per-match output is unbounded

The pattern `@Composable\nfun $NAME($$$ARGS)` matched whole Kotlin function
declarations, and the tool printed every matched node in full — one match was 117
lines, and six matches ran to roughly 6k tokens. Kotlin and Swift functions are
long, so this is far worse outside TypeScript.

Per repository rules, a tool that can emit unbounded model-visible text must
bound it. Fix: cap printed lines per match (head retention plus an elided-line
count) independently of `resultLimit`, since `resultLimit` caps match count, not
match size.

### Finding 8 — `context` prints class bodies twice

`context SplashAuthController` spent ~1,071 tokens on the full class body and
then repeated all eleven method bodies individually, consuming 2,090 of a 2,200
budget for content the caller already had. For a class target, print the class
signature plus members, or the body alone — not both.

### Finding 9 — two more Kotlin grammar bugs (upstream)

Only 4 of 864 files degraded (0.46%), so the grammar is broadly healthy. Two
confirmed constructs, both reduced to minimal repros against pin
`fwcd/tree-sitter-kotlin` 0.3.8:

```text
FAIL  when branch with a bare if/else body:  "P" -> if (c) "a" else "b"
ok    same branch with braces:               "P" -> { if (c) "a" else "b" }
FAIL  empty collection literal default:      annotation class D(val a: Array<String> = [])
ok    non-empty collection literal:          annotation class D(val a: Array<String> = ["x"])
ok    when with `in`, `!in`, `is` branches
ok    KDoc and line comments inside a value parameter list
```

Note the earlier one-line-class-body failure (Finding 5) never appeared in real
code, as predicted. Upstream grammar issues; recommend no local action beyond
recording them.

Degradation is also graceful: `outline` on a degraded 279-line file emitted
`warning: parser recovered with errors` and still listed the object, all fifteen
members, and three nested enums with every constant.

### Confirmed working on Kotlin

- Absolute paths outside the session cwd work across every tool.
- `implementations` on an interface with 7 textual matches returned exactly the
  one real implementor, no false positives from constructor parameters.
- `callers` on a top-level `fun` found all four cross-file call sites, so call
  resolution works through `globalByName` even where import resolution fails.
- `discover`, `show` (including `@Stable` annotation retention in the signature),
  `references`, `outline` (nested enum constants, `object` declarations,
  overloads), and same-module `deps`.

## Swift pass — `references/athenapatient-ios`

Corpus: 1,642 `.swift` files, ~112k LOC, Xcode project plus one SwiftPM
`LocalPackages/PersonaMockData`, SwiftUI throughout, ~700 XCTest files using
`@testable import athenaPatient`. Full-tree parse: 1,642 files and 2,512
top-level declarations in 1,090 ms.

### Finding 10 — `outline` hides `internal` declarations (severe, one-line fix)

`outline` on a file declaring `protocol FeatureFlagProviding` returned **`No
declarations`**, while `implementations` resolved that same protocol at that same
file and line. Adding `includePrivate: true` printed the protocol and both
requirements.

Root cause is `keepVisibility` in `src/ast/queries/outline.ts:39`:

```ts
return (decl) => decl.visibility === "public" || decl.visibility === "protected";
```

`internal` is dropped. Swift's default access level is `internal`, and app-target
code almost never writes an explicit modifier, so most Swift declarations vanish.
Measured across the corpus: **1,470 of 1,640 files with declarations (90%) have
no `public` or `protected` top-level declaration at all**, and the visibility
histogram is `internal` 2,215, `public` 208, `private` 89. The primary
orientation tool is therefore empty on nine of ten Swift files.

Kotlin escaped this only because its default access level is `public`. Java
package-private declarations and C# `internal` types will hit the same filter, so
verify during those passes.

Fix: when `includePrivate` is false, exclude only `private`. Module-visible is not
private. One line, and it is the highest-payoff fix found in the audit so far.

### Finding 11 — Swift module imports expand to whole modules (severe)

`resolveSwiftFileDep` resolves `import Module` by finding directories named
`Module` (or `Sources/Module`) and returning **every `.swift` file inside, up to
500**. Consequences measured on this corpus:

- `deps` on one 60-line test file returned more than 100 internal files and was
  still truncated, because `@testable import athenaPatient` expands to the whole
  app target.
- `impact --mode dependents` on an app class spent its entire output on ~700
  "file importers" (every test file), hit the 50-entry cap, and never printed the
  symbol callers that make the tool useful.
- `import XCTest` resolved to `athenaPatient/PackageCore/Extensions/XCTest/`,
  a local directory whose name collides with the system module. Any directory
  named after a system module hijacks that import.
- `LocalPackages/PersonaMockData/Package.swift` was returned as a module source
  file; a manifest is not a dependency target.

This is a design mismatch, not only a bug. Swift imports are module-granular and
intra-module references need no import at all, so a file-level import graph
simultaneously over-reports (module fan-out) and under-reports (the intra-module
case that dominates an app target).

Recommended fix, in order:

1. Stop expanding modules to files. Return a module-level id, the way Kotlin
   wildcard imports already return `externalId`.
2. Derive Swift file edges from symbol resolution instead — files declaring
   symbols this file references. Relationship resolution already works on Swift,
   so the data exists.
3. Independently of Swift, cap the file-importer list in `impact` and print
   symbol callers first, since importer lists are the least specific evidence.
4. Exclude `Package.swift` and skip directory matches for known system module
   names.

### Finding 12 — four Swift grammar bugs (upstream)

24 of 1,642 files degraded (1.5%). All 24 are explained by four constructs,
each reduced to a minimal repro against pin `alex-pinkus/tree-sitter-swift` 0.7.3:

```text
FAIL  force-unwrap adjacent to a comment:   C.get()!// swiftlint: disable:this force_unwrapping   (13 files)
ok    same with a space before //
ok    C.get()!// note      <- parses, but SILENTLY MISPARSES: !// lexes as a
                              custom operator and `note` becomes an operand
FAIL  @available before a macro expansion:  @available(iOS 17.0, *)\n#Preview { }      (5 files)
ok    bare #Preview, with or without traits
FAIL  optional binding from await:          if let x = await p.token?.hash { }         (4 files)
ok    same without await; ok  await optional chain outside a binding
FAIL  optional cast then nil-coalesce:      d.object(forKey: k) as? T ?? k.default     (2 files)
ok    @testable import, @Observable, @Test/#expect, @Suite, typed throws,
      parameter packs, `each T` packs, `some View`, @MainActor, CRLF sources,
      @Environment(\.keyPath), macro declarations
```

The silent-misparse variant matters more than the hard failures: it produces a
plausible tree with no `parseDegraded` signal. Still an upstream fix; recommend
recording only.

### Confirmed working on Swift

- `implementations` found the single real conformance and labeled it `inferred`.
- `callers` on a name shared by a protocol requirement and its implementation
  reported ambiguity and listed both candidates with signatures.
- `discover` by `declarationKind`, including nested enums.
- `outline` with `includePrivate: true` renders protocols, requirements, and
  multi-line signatures correctly.
- Throughput is fine at 1,642 files.

## TypeScript pass 2 — `references/pi`

Corpus: 817 `.ts` files, ~214k LOC, five packages under npm workspaces, and —
unlike this repo — a root `tsconfig.json` that declares `paths` for every
workspace name. Full-tree parse: 5,036 top-level declarations in 1,137 ms.

### Finding 1 confirmed by contrast

`reverse_deps packages/tui/src/index.ts` returned real importers here, resolving
`@earendil-works/pi-tui` through the tsconfig `paths` branch. Same tool, same
language, same monorepo shape returns nothing in this repo purely because this
repo declares no `paths`. That isolates the defect to the missing
`workspaces`-based fallback described in Finding 1; the `paths` branch itself is
healthy.

### Finding 2 reproduces, with a clean control

`callers configureHttpDispatcher` found all four call sites inside function
bodies and silently dropped both top-level sites (`src/cli.ts:18`,
`src/rpc-entry.ts:10`). One symbol, both behaviors, same run.

`callers registerBuiltInImagesApiProviders` reported `No relationship sites`
although the file calls it seven lines below its own declaration.

### Finding 3 reproduces and is the only parse failure in 214k LOC

1 degraded file out of 817 (0.12%), and line-drop bisect landed on the same
construct as before:

```ts
const actual = await importOriginal<typeof import("@earendil-works/pi-ai/compat")>();
```

Two large TypeScript corpora now agree the vendored grammar is healthy except for
this one vitest-mock idiom. Keeping the `parser: degraded` warning is enough.

### Finding 7 is worse than recorded — captures are echoed in full

`ast_search` prints the matched node in full **and then prints every
metavariable capture in full**, so a `$$$BODY` capture repeats the entire
function body a second time. Three matches in one 170-line file produced roughly
double the necessary output.

Revised fix: cap printed lines per match with head retention, and never echo a
multi-line capture verbatim — print its line count, since the capture text is
already inside the match text.

### Finding 8 is worse on TypeScript than on Kotlin

`context OutputAccumulator budget=1800` printed the whole class body (~1,263 tok),
then reprinted the `constructor`, `append`, `finish`, and `snapshot` bodies
verbatim (~443 tok of pure duplication). The budget then ran out: five private
methods degraded to signature-only and the callers/dependents section never
appeared at all. Roughly a quarter of the budget bought nothing, and it displaced
exactly the relationship data `context` exists to provide.

### Finding 10 does not affect TypeScript

The TypeScript adapter assigns `private`/`protected` only from class member
modifiers and `#private` fields; every top-level declaration is `public`
(4,984 public, 0 internal or private across the corpus). So the visibility filter
never hides TypeScript declarations — but it also cannot distinguish exported API
from file-local helpers. Directory `outline` on `core/compaction` listed
non-exported functions such as `getMessageFromEntry` with no marker. `discover`
already has `sourceExport` and `packageSurface` for that need, so this is a note,
not a fix request.

### Confirmed working on `references/pi`

- `discover surface: packageSurface` resolved `@earendil-works/pi-tui` and
  synthesized the correct `import { Container } from "@earendil-works/pi-tui"`
  line even though the package `types` field points at an unbuilt
  `dist/index.d.ts`.
- Directory `outline` output is high quality at scale: interface members,
  multi-line signatures, and elided const initializers.
- `callers` for in-body sites, `deps` within a package, `impact`, and the
  ambiguity report when a name has several candidates.
- Minor: `discover surface: sourceExport` returned a README markdown heading
  alongside the class. Expected given markdown is a supported language here, but
  worth knowing when reading results.

## Rust pass — `references/tokio`

Corpus: 787 `.rs` files, ~178k LOC, cargo workspace with five published crates
plus internal members. Full-tree parse: 9,426 top-level declarations in 2,126 ms
and **0 degraded files** — the cleanest parse health of any corpus so far.

### Finding 13 — Rust `impl` blocks are modeled as phantom declarations (severe)

`IMPL_ITEM` handling in `src/ast/languages/rust.ts:397` emits impl methods as
flat siblings at file scope and, for trait impls only, adds a marker declaration:

```ts
const marker = finishDecl({ kind: "class", name: target, visibility: "public",
                            children: [], bases: [trait], /* span = whole impl */ }, null);
```

The marker exists so `implementations Trait` can match through `bases`, and that
part works well. Everything else about it leaks:

- **Every type collides with itself.** The marker takes the *target type's* name,
  so `context LinkedList` returned five candidates: the real struct plus four
  markers, all named `LinkedList`, all kind `class`. Pinning requires a line
  number and four of the five lines are wrong. tokio has ~1,248 trait impls
  across its three main crates, so roughly 13% of all Rust declarations in the
  corpus are phantom entries that shadow real ones.
- **`outline` dumps impl bodies.** The marker has `children: []` and no signature
  text, so the formatter prints its whole source span. `outline` on
  `util/linked_list.rs` printed the complete `fmt::Debug` and `Default` impl
  bodies, then printed the same methods again as siblings.
- **`visibility: "public"` is hardcoded** on the marker while real items keep
  their true visibility. Combined with Finding 10 this inverts the output: the
  default `outline` of `linked_list.rs` showed *only* the five impl markers and
  hid the `LinkedList` struct, the `Link` trait, the `Pointers` struct, and every
  method.
- **Inherent impls produce no container at all.** 1,253 of them in `tokio/src`.
  Their methods appear at file top level with no owner shown, so `outline` listed
  two indistinguishable `pub(crate) fn new()` entries — one `LinkedList::new`,
  one `Pointers::new`.

The IR itself knows the owners: `callers push_front` correctly reported
`method LinkedList.push_front` alongside three other types. This is a modeling
and formatting defect, not missing data.

Fix: name the marker for what it is (`impl Default for LinkedList`), nest the
methods as its `children` instead of emitting siblings, inherit visibility rather
than hardcoding `public`, and emit the same container for inherent impls so
methods hang off their type.

### Finding 10 confirmed on Rust, and it is self-inconsistent here

`rustVisibility` maps `pub(crate)`/`pub(super)`/`pub(in path)` to `internal`, and
`rustExported()` at `rust.ts:214` explicitly treats `internal` as **exported**.
`outline` then hides exactly those declarations. One adapter, two opposite
answers about the same item.

Corpus counts: `private` 5,235, `public` 2,892, `internal` 1,299, and **348 of
753 files with declarations (46%) have no public declaration at all**. Three
languages now confirm the same root cause — Swift at 90% of files, Rust at 46%,
Kotlin exempt only by defaulting to public.

### `deps` works well on Rust, with one silent drop

`use crate::...` resolution is solid, including `mod.rs` targets: on
`runtime/task/core.rs` it resolved `crate::future::Future` to `future/mod.rs`,
`crate::runtime::task::raw::{self, Vtable}` to `runtime/task/raw.rs`, and
`crate::runtime::task::{Id, Schedule, ...}` to `runtime/task/mod.rs`.

One import vanished from the output entirely — neither internal nor external:

```rust
use crate::loom::cell::UnsafeCell;   // loom/std/mod.rs declares `pub(crate) mod cell { ... }` inline
```

The path passes through an inline `mod` inside a `cfg`-gated re-export, which is
genuinely hard to follow. But dropping it silently is the wrong failure mode.
Cheap fix: on failure, fall back to the longest existing module prefix
(`crate::loom` → `loom/mod.rs`), which is both resolvable and useful.

### Confirmed working on Rust

- `implementations AsyncRead` returned 12+ real impls across nine files with
  correct generic headers (`impl<R: AsyncRead> AsyncRead for BufReader<R>`).
  Minor inconsistency: same-file impls print without the `inferred` label while
  cross-file impls print with it, which reads like a confidence difference that
  isn't one.
- `callers` ambiguity reporting is genuinely good on Rust: four same-named methods
  across four types, each with owner and full signature.
- `outline` with `includePrivate: true` handles struct fields, trait associated
  types and required methods, nested `#[cfg(test)] mod tests`, and attribute
  retention (`#[derive(Debug)] #[repr(C)]`) correctly.
- Parse throughput and correctness need no work: 0 degraded files.

## Go pass — `references/prometheus`

Corpus: 726 `.go` files, ~368k LOC, single module (`github.com/prometheus/prometheus`).
Full-tree parse: 13,480 top-level declarations in 2,169 ms, **0 degraded files**.

### Finding 14 — Go visibility collapses package-visible into `private`

`go.ts:174` is the whole mapping:

```ts
return goExported(name) ? "public" : "private";
```

Go has no file-private level. A lowercase identifier is visible to its entire
package — the exact analogue of Rust `pub(crate)` and Swift `internal`, both of
which the adapters map to `internal`. Go alone calls it `private`, so the
Finding 10 filter drops it: 5,635 of 13,480 declarations, and 70 of 697 files
with declarations render as nothing.

Go makes the resulting output worse than empty, because visibility is computed per
identifier rather than per type. `outline tsdb/agent/series.go` printed 17 methods
and **zero type declarations**:

```text
L49-51: func (m *memSeries) Ref() chunks.HeadSeriesRef
L71-83: func (m *seriesHashmap) Get(hash uint64, lset labels.Labels) *memSeries
L176-238: func (s *stripeSeries) GC(mint int64, retainLabels bool) map[...]
```

`memSeries`, `seriesHashmap`, `stripeSeries`, `seriesSnapshot`, and
`deletedSeries` are all unexported, so every owner is hidden while its exported
methods are shown. Unexported methods on those same types are hidden too, inside a
package where both are equally reachable.

Fix: map unexported Go identifiers to `internal`. With the Finding 10 change
(hide only `private`/`fileprivate`) that one edit makes Go, Rust, and Swift
correct together.

### Finding 15 — `implementations` cannot find Go interface implementers

Go satisfies interfaces implicitly, so there is no heritage clause to match.
Pinned directly at the interface:

```text
implementations Appender  storage/interface.go:413
  → storage/remote/write_handler.go:495  type remoteWriteAppender struct {
```

One result. It was found only because that struct's source textually mentions
`storage.Appender`. In the same repo, 12 distinct types declare
`Commit() error` (the Appender marker method) and 7 more embed `storage.Appender`.
Recall is roughly 1 in 12.

Unpinned, the tool is also misdirected: `implementations Appender` ranked seven
*methods named `Appender`* (constructors returning `storage.Appender`) above the
interface itself, because Go puts method names and type names in one lookup space.

Fix: method-set matching. The IR already records owners and method names — match
types whose declared method names are a superset of the interface's. Failing that,
say in the output that Go results only cover embedding, so a single hit is not
read as "one implementer".

### Go dep resolution is correct and bounded, with three rough edges

`resolveGoFileDep` expands each package import to every non-test `.go` file in the
package directory. This is the same strategy as Swift Finding 11, but it behaves,
because a Go package is one non-recursive directory: the largest in prometheus is
30 files and the median is 1–2. Swift's problem was directory granularity (a module
directory held ~1,500 files), not file expansion.

Still measured on `tsdb/head.go`:

1. **4.6x amplification.** 14 internal package imports became 65 internal file
   edges. Bounded, but the reader pays for it.
2. **Build constraints are ignored.** Those 65 included `labels_dedupelabels.go`,
   `labels_slicelabels.go`, and `labels_stringlabels.go` — three mutually exclusive
   build-tag variants of the same package — plus both `head_chunks_other.go` and
   `head_chunks_windows.go`. The reported dependency set cannot exist in one build.
3. **Externals consume `resultLimit`.** At `resultLimit: 20` the output was 2
   internal files followed by 18 external names (`context`, `errors`, `fmt`, `io`,
   `log/slog`, …) and truncated before the interesting internal edges. Go files
   carry ~15 stdlib imports as a matter of course. Budget internal and external
   separately, or collapse externals to a count when truncating.

### Confirmed working on Go

- 0 degraded files over 368k LOC.
- Receiver methods print their full receiver (`func (m *Matcher) String() string`),
  so the flat listing stays readable even though methods are not nested under
  their type — the same shape that is unreadable in Rust is fine here.
- `iota` const blocks, struct fields, and named return tuples all format cleanly.
- Ambiguity reports list owner and full signature for every candidate.

## C# pass — `references/jellyfin`

Corpus: 2,122 `.cs` files, ~326k LOC, 42 `.csproj` projects. Parse: 2,648 ms,
**118 degraded files (5.6%)** — the worst degradation rate of any corpus. Recursive
declaration extraction is rich: 21,757 declarations (7,257 methods, 5,547
properties, 2,507 fields, 1,838 classes, 1,064 enum members, 213 interfaces).

### Finding 16 — the C# grammar has no collection-expression support (severe)

The pinned grammar does not implement C# 12 collection expressions at all. Both
outcomes are bad, and only one of them is reported:

```text
int[] a = [];        → parse error          (flagged as degraded)
int[] a = [1];       → element_binding_expression, no error  (silent misparse)
int[] a = [..b, 1];  → element_binding_expression, no error  (silent misparse)
```

`[1]` is not parsed as a collection expression; it happens to fit the
null-conditional indexer rule, so the tree is plausible and `hasError` stays
false. `[]` has no such fallback, so it errors.

Measured on jellyfin: 123 files contain a bare `[]` expression and 118 files
degraded — near-exact correlation, so one unsupported token explains essentially
the entire 5.6%. A further 110 files (306 occurrences) contain non-empty
collection expressions and are **silently misparsed with no warning**. Together
roughly 11% of the corpus parses wrong, and only half of it is flagged.

Bisect kept landing on ordinary-looking lines because the construct appears in
every position: `Files = [];`, `sortBy ?? []`, and a bare `? []` ternary branch.

Unlike the Swift failures this is not an upstream bug to wait on. The grammar
comes from `@vscode/tree-sitter-wasm@0.3.1`, which is the latest published
version, so a dependency bump will not fix it. Fix: move the `c_sharp` grammar to
a `release`-sourced pin from `tree-sitter/tree-sitter-c-sharp`, the same mechanism
`swift` already uses in `grammars/manifest.json`.

### Finding 17 — C# `deps` resolves a namespace import to at most one file

`resolveCsharpFileDep` looks a `using` up in a path-suffix/FQN index and returns
`internalPaths([file])` — one file, chosen by `pickClosest`. But a C# `using`
imports a **namespace**, which spans many files across many projects. This is the
exact inverse of Swift Finding 11: Swift over-expands a module to every file, C#
under-resolves a namespace to one file or none.

`deps` on `MediaBrowser.Controller/Library/ILibraryManager.cs` (20 usings):

```text
MediaBrowser.Controller/Entities
  TV/Episode.cs   Genre.cs   LinkedChildType.cs   Person.cs
external:
  ... MediaBrowser.Controller.Dto, MediaBrowser.Controller.Entities,
      MediaBrowser.Controller.Providers, MediaBrowser.Model.Querying, ...
```

All four internal edges came from the four `using X = Fully.Qualified.Type;`
**aliases** on lines 21–24, which name a type and therefore hit the FQN index.
Every one of the 12 plain first-party namespace usings was reported `external` —
namespaces defined in this same repository. The result even contradicts itself:
`MediaBrowser.Controller.Entities` is listed as an external id while the directory
that backs it supplies the four internal files.

Consequence: C# has effectively no internal file graph, so `reverse_deps` and
`impact --mode dependents` under-report on C# the same way they over-report on
Swift.

### Finding 10 on C#: mapping is correct, and the blank output is worse

`csharp.ts:226`–`234` maps visibility correctly, including a default of `internal`
for undecorated type declarations. The filter then hides 251 `internal`
declarations (plus 3,996 `private`, which is right for C#).

The corpus metric `filesAllHidden: 0` is misleading for C#, because the top-level
declaration is always the namespace. `outline` on an `internal` type's file prints
the namespace and nothing else:

```text
outline Jellyfin.Server.Implementations/FullSystemBackup/BackupOptions.cs
  L1: namespace Jellyfin.Server.Implementations.FullSystemBackup;
```

The `internal class BackupOptions` and all its properties are gone, and the output
reads like an empty file rather than a filtered one. C# `internal` is
assembly-visible, and jellyfin ships 42 assemblies, so this is project API being
hidden.

### The Go `resultLimit` problem repeats here

At `resultLimit: 20` the same `deps` call spent 18 of 20 slots on external
namespace names and truncated the internal list. Budgeting internal and external
separately fixes both languages at once.

### Confirmed working on this corpus

- `implementations` is accurate and resilient: `ILibraryManager` at repo scope
  found `public class LibraryManager : ILibraryManager` at
  `Emby.Server.Implementations/Library/LibraryManager.cs:64` **even though that
  file is one of the 118 degraded ones** — partial-tree recovery still yields the
  class header. The `parser: degraded on at least one file` warning printed
  alongside it, which is exactly the honest signal that warning is for.
- Scope discipline is real: the same query limited to `MediaBrowser.Controller`
  correctly returned nothing, since the implementation lives in another project.
- Verified parsing fine: primary constructors, file-scoped namespaces, `required`
  members, raw string literals, generic attributes, list patterns, `init`
  accessors, static abstract interface members, `u8` literals, lambda default
  parameters, `ref readonly` parameters, alias-any-type usings, `[InlineArray]`.
  Only C# 13 `params ReadOnlySpan<T>` also fails, and it appears twice in the
  corpus.

## Java pass — `references/micronaut-core`

Corpus: 4,997 `.java` files, ~470k LOC, 81 Gradle modules, 46 `src/main/java`
source roots. Parse: 2,370 ms, **13 degraded files (0.26%)**. Recursive extraction:
42,831 declarations (24,956 methods, 5,738 constants, 4,450 classes, 1,434
interfaces).

### Finding 18 — Java package-private is `internal`, so the filter blanks 287 files

The mapping is right (package-private → `internal`), and Finding 10's filter then
drops it: 5,679 declarations hidden, and **287 of 4,615 files with declarations
render as nothing**.

```text
outline core/src/main/java/io/micronaut/core/io/FileReadable.java
  No declarations
```

That file is a package-private `final class FileReadable implements Readable` with
a constructor and six methods. Java package-private is the same visibility level as
Rust `pub(crate)`, Swift `internal`, C# `internal`, and Go lowercase.

Four languages now fail the same one-line filter: Swift 90% of files, Rust 46%,
Java 6%, C# every `internal` type, plus Go once its mapping is corrected
(Finding 14). The fix stays one line in `outline.ts:39`.

### Finding 19 — annotated varargs is the only Java grammar gap

```text
void m(String @Nullable ... a) { }   → parse error
```

An annotation between the type and `...` is legal since Java 8. It is the entire
degradation: 13 files in the corpus contain the construct and exactly 13 files
degraded. Every other type-use annotation position parses (`String @Nullable []`,
`List<@Nullable String>`, annotated receiver/cast/throws/bound/`new`), as does all
of modern Java — sealed types with `permits`, records, local records, switch
patterns, text blocks, `instanceof` patterns, generic constructor references.

Severity is low, because error recovery is excellent. With `includePrivate` the
degraded file still yields the class, both constructors — including the one with
the unparseable parameter, printed verbatim — and both methods, under an honest
`warning: parser recovered with errors`. Same grammar source as C#
(`@vscode/tree-sitter-wasm`), but unlike Finding 16 nothing is silently misparsed.

### Finding 20 — JVM `deps` never resolves a cross-module import (severe)

`sourceRootsFor` in `jvm-file-deps.ts` builds candidate source roots from only
three things: every ancestor directory of the importing file, that file's own
inferred source root, and the fixed suffixes `<scopeRoot>/src/main/java` and
`<scopeRoot>/src`. Nothing enumerates sibling module source roots, so in any
multi-module Gradle or Maven build an import from module A to module B cannot
resolve, and lands in `external`.

Measured with `forwardEdges` over a 300-file sample of micronaut:

```text
internal edges                              183
io.micronaut.* imports reported external     918
third-party imports                        1094
```

**16.6% of first-party imports resolve.** The unresolved ones are not obscure:
`io.micronaut.core.annotation.Internal` is `core/src/main/java/io/micronaut/core/
annotation/Internal.java`, sitting in the repo. Across the corpus, 16,931 of
34,661 import lines (49%) are first-party, so about half the import graph is in
scope and five sixths of that is lost.

Kotlin shares this resolver, and the earlier Kotlin pass only proved *same-module*
`deps`. The same measurement on `references/ktor` (2,318 `.kt` files, layout
`<module>/jvm/src/<package>/…`, which matches none of the hardcoded suffixes):

```text
internal edges                    7
io.ktor.* imports reported external   841
```

**0.8%.** So `deps`, `reverse_deps`, and `impact --mode dependents` are effectively
non-functional on multi-module JVM repositories — the common shape for both
languages.

Fix: index package-path suffixes once per scope root, the way
`csharp-file-deps.indexPathSuffixes` already does, and resolve a type import to the
matching file and a wildcard import to the matching package directory. That also
removes the hardcoded source-root suffix list, which cannot keep up with layouts
like ktor's.

Together with Findings 11 and 17 this makes file-dep resolution the weakest area of
the toolset: Swift over-expands a module to every file, C# collapses a namespace to
one file, JVM drops cross-module edges.

### Finding 21 — heritage site previews show an annotation instead of the signature

```text
implementations Readable
  core/src/main/java/io/micronaut/core/io/FileReadable.java
    L33  implementation  inferred  @Internal
  core/src/main/java/io/micronaut/core/io/UrlReadable.java
    L35  implementation  inferred  @Internal
```

Neither row names the implementing type. `linePreview`
(`graph/relationships.ts:127`, used at line 275) returns the raw source line at the
site's start line, and a declaration's span starts at its first annotation. The
correct text is already available — `show` prints
`@Internal class FileReadable implements Readable` from `candidate.signature`.

3,339 of 4,997 micronaut files have an annotation-led top-level type, and
annotation-heavy code is normal for both Java and Kotlin, so most JVM
`implementations`, `callers`, and `references` output loses the one identifier the
reader wants. Fix: use the declaration signature for declaration-shaped sites
instead of the raw start line.

### Confirmed working on Java

- `implementations Readable` found both implementors with correct scoping.
- `show` reported the ambiguity between `class FileReadable` and its constructor
  with full normalized signatures, including the annotation prefix.
- 0.26% degradation over 470k LOC with useful recovery on every degraded file.
- Same-module `deps` resolves correctly (`runtime/exceptions/…`,
  `runtime/server/…`), which is what makes Finding 20 easy to miss.

## Odin pass — `references/Odin`

Corpus: the Odin distribution itself — 1,839 `.odin` files, ~732k LOC (largest
corpus in the sweep). Parse: 5,712 ms, **53 degraded files (2.9%)**. Extraction:
108,948 top-level declarations, 188,572 recursive (56,044 procedures, 51,557 enum
members, 41,638 constants, 28,067 fields, 5,755 structs).

Finding 10 barely applies: Odin visibility is 186,431 public against 2,141
`@(private)`, and only 34 files render fully hidden.

### Finding 22 — top-level `when` blocks yield zero declarations (severe, silent)

Odin's compile-time `when` is the standard mechanism for platform and
configuration branching. Everything inside a top-level `when` is dropped, with no
`parseDegraded` flag:

```text
package p
when X {
 foo :: proc() { }
 BAR :: 1
}
→ 0 declarations, degraded=false
```

Real consequence:

```text
outline vendor/OpenGL/wrappers.odin
  No declarations
```

That file is 1,563 lines and declares roughly 370 procedures, all inside
`when !GL_DEBUG { … }`. Same for `core/os/env_linux.odin` (everything under
`when ODIN_NO_CRT`) and the generated curve tables
(`core/crypto/_weierstrass/secp384r1_table.odin`, 5,970 lines, one table under
`when crypto.COMPACT_IMPLS == false`).

Scale: 122 files extract zero declarations. 75 are `doc.odin` files that genuinely
declare nothing, so **47 files silently lose all content**. 221 files (12%) contain
a top-level `when`, holding 11,185 indented `::` declarations against 92,165
unindented ones — an upper bound on what partial files lose.

A `when` inside a struct body is worse but not present in this corpus:

```text
S :: struct {
 a: int,
 when X { b: int, },
 c: int,
}
→ struct:S(a, when)   variable:c   degraded=true
```

The struct gains a phantom child literally named `when`, loses `b`, and `c` escapes
to file scope as a `variable`. This one is upstream, not ours: the tree carries
`ERROR` nodes and a `field` whose identifier is `when`, so it belongs with the
Finding 23 grammar gaps. It does at least flag degraded.

Fix for the top-level case: treat `when`/`else` blocks as transparent containers
during extraction — descend and attach their declarations to the enclosing scope.
The tree is clean there (`when_statement` → `block` → declarations, plus
`else_when_clause` and `else_clause`), and `declsFromNode` already does exactly
this for `FOREIGN_BLOCK`. Odin has no
per-configuration IR, so emitting every branch matches how `deps` already treats
mutually exclusive Go build-tag files (Finding 14's third rough edge).

### Finding 23 — nine upstream Odin grammar gaps

The pin is `tree-sitter-grammars/tree-sitter-odin` v1.3.0, which is the latest tag,
so all of these need upstream reports. Each was reduced to a minimal repro and each
produces a hard error — nothing misparses silently.

```text
for first := true; k, v in m { }     for with both an init statement and a range clause
sd: = 1 + 2                          space between `:` and `=`
a.id == ^os.File                     pointer type in expression position
buf: [dynamic; 32]byte               fixed-capacity dynamic array (also `[dynamic; $N]$E`)
x := #partial [Flag]u8 { .A = 1 }    #partial enum-array literal
x := #sparse[Flag]u8 { .A = 1 }      #sparse enum-array literal
x := #simd[4]i32{1, 2, 3, 4}         #simd composite literal (the type alone parses)
O :: 0o4_010_000                     underscores in an octal literal (hex is fine)
S :: struct #align(align_of(uint))   #align with a non-literal argument
S :: struct { when X { b: int, }, }  `when` inside a struct body (see Finding 22)
```

Everything else modern parses: parametric polymorphism with specialization
(`$T/[]$E`), `where` clauses including multiple constraints, `#partial switch`,
`or_return`, `bit_set`, `matrix`, `#soa`, `#simd` types, procedure groups, unions
with `#no_nil`, `when`, `foreign` blocks with `---`, `using` in structs, labeled
loops, `#assert`, `#+private` and `#+build` file directives, nested block comments.

Recovery is good. `core/container/pool/pool.odin` fails on
`intrinsics.type_field_type(T, link_field) == ^T` inside a `where` clause, and
`outline` still returns all 14 declarations, every struct field, and the `where`
clause verbatim under `warning: parser recovered with errors`. `callers
opt_write_key` found both call sites in the degraded
`core/encoding/json/unparse.odin`, two lines after its parse error.

### Finding 24 — `deps` labels large in-repo packages `external`

`odin-file-deps.ts` is the most carefully built of the file-dep adapters:
`ODIN_ROOT` support, nearest-first collection roots so a project `vendor/` beats
the compiler tree, and `boundedInternalPaths` so a fat package does not dump 40
files. That bound is the Swift Finding 11 fix, already implemented here.

The presentation undoes it. `boundedInternalPaths` (`file-dep-util.ts:24`) falls
back to `externalId(...)` above `maxFiles = 12`, so an in-repo package appears
under the `external:` heading:

```text
deps core/encoding/json/unparse.odin
  strings/…  io/…  slice/…      (16 internal files)
external:
  base:runtime
```

`base:runtime` is `base/runtime/` in this very tree — 45 files. Nothing
distinguishes "not in this repository" from "too large to list", and the threshold
is all-or-nothing: 12 files list in full, 13 vanish. `core:time` sits at 14.

Measured across the corpus: 862 of 4,176 collection imports (**20.6%**) resolve to
an in-repo package and are then reported external — `base:runtime` (308 imports, 45
files), `core:os` (174, 85), `core:time` (115, 14), `core:sys/windows` (63, 47),
`core:sys/posix` (53, 59), `core:sync` (33, 21).

Fix: keep the bound, change the label. Emit a resolved package edge with its
directory and file count (`base/runtime/ (45 files)`) so the reader knows the
dependency is internal and why it is not enumerated.

### Finding 25 — `discover` name and documentation matching is case-sensitive

Not Odin-specific; found here and reproduced on this repository.

```text
discover core/container  substringName "queue"
  → field queue, constant enqueue, constant dequeue

discover core/container  substringName "Queue"
  → struct Queue, struct Priority_Queue
```

Neither query returns the other's results. Same on TypeScript: `prefixName
"Outline"` in `packages/agent/src/ast/queries` returns `OutlineOptions`,
`OutlineRow`, `OutlineFileView`, `OutlineResult` and none of `outlinePath`,
`outlineRecursive`, `outlineFromIr`.

Every language in the sweep capitalizes types and lowercases functions, so a
`prefixName` or `substringName` query silently returns half the surface — and
`discover` is the tool for the case where the caller does not know the exact name.
Root cause is `discover.ts:59-60`, raw `startsWith` / `includes`; line 261 does the
same for `documentation` terms.

Fix: case-fold both sides for `prefixName`, `substringName`, and `documentation`.
Leave `exactName` exact, and keep the existing exact-match ranking bonus so
same-case hits still sort first.

### Confirmed working on Odin

- `deps` collection resolution: `import "core:strings"` correctly expanded to all
  six files of `core/strings/`, and relative/path imports resolve too.
- Extraction handles `#+private` and `#+build` file directives, `foreign` block
  procedures, `_ :: pkg` import silencers (correctly not named declarations),
  parametric structs (`Pool :: struct($T: typeid)`), and `where` clauses on
  procedure signatures.
- `callers` and `discover` return correct owners and signatures, including through
  degraded files, with the honest `parser: degraded on at least one file` footer.
- 2.9% degradation over 732k LOC, and every degraded file still yielded its
  declarations.
