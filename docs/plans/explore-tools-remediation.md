# Explore tools remediation plan

Source: `docs/plans/explore-tools-audit.md`, Findings 1–25, measured across eight
languages and eight corpora.

Ordering rule: ship the changes that make correct output appear where output is
currently absent or wrong, before the ones that add new capability. Every task
below is independently green and committable.

## Standing context

Three decisions already settled, recorded so they are not relitigated:

- **Odin support is removed, not repaired.** The simulation-heavy project that
  justified carrying Odin is being written in Rust instead. Nothing else in the
  repository needs Odin. Scope under Task Q; the grammar-ownership plan that
  briefly lived there is dropped in full.
- **No Rust rewrite of the AST core.** Considered and declined; reasoning under
  "Rust core engine — evaluated and declined".
- **Rust language support matters more than it did.** The simulation codebase
  moves there, so Tasks K and O stop being tail cleanups and become the support
  quality for a codebase we will actually navigate. Neither changes phase, but
  both are now load-bearing rather than nice to have.

Findings 22, 23 and 24 are retired with the Odin adapter. Findings 1–21 and 25
are unaffected and still carry the broadest impact.

## Ordering

| Phase | Tasks | Why this order |
| --- | --- | --- |
| 0 | Q, R | Q deletes surface every later phase would otherwise touch. R is standing. |
| 1 | A–E | Small, local, no shared plumbing. Fixes silent wrongness. |
| 2 | F–J | F introduces the resolution kind that G, H and J need. |
| 3 | K, M | Declaration modeling. Changes outline shape, so lands after 1. |
| 4 | N–O | New capability and fallback resolution. Largest, least certain. |
| 5 | P | One grammar re-pin plus upstream reports. Independent of everything. |

Task Q first: it is mechanical, removes two adapters and a grammar, and shrinks
what Tasks A, F and M have to touch. Then Phase 1 Task A, the one-line
`outline.ts:39` fix with the widest reach.

## Phase 0 — clear the deck

### Task Q — remove Odin support

Delete the Odin adapter, its dep resolver, its grammar and its fixtures. YAGNI:
the only motivation for carrying an eighth language was a project that is now
being written in Rust, and no other consumer needs it. Re-add later behind its own
plan if that changes.

Delete:

```text
packages/agent/src/ast/languages/odin.ts            (374 lines)
packages/agent/src/ast/languages/odin-file-deps.ts  (175 lines)
packages/agent/src/ast/languages/fixtures/sample.odin
packages/agent/src/ast/grammars/odin.wasm
```

Edit:

- `src/ast/registry.ts` — the `odinAdapter` import at line 7 and its entry in the
  adapter list at line 118. The adapter owns its own `.odin` extension mapping, so
  no separate extension table needs touching.
- `src/ast/grammars/manifest.json` — drop the `odin` entry (the last element of
  `grammars`, `source: "built"`, pin `v1.3.0` / `e8adc73`). Kotlin remains a
  `built` grammar, so `build-grammars-container.sh` and the wasi-sdk toolchain
  stay necessary; nothing else in `build-grammars.ts` is Odin-specific.
- `test/extensions/explore/grammars.test.ts` — the `odin` block at line 42.
- `extensions/explore/tools/ast-search.ts:31` — remove `odin` from the
  engine-registered language list in the `language` parameter description. This is
  model-visible text, so it must not advertise a language the registry no longer
  has.
- `docs/CONTRIBUTING.md:42` — "kotlin, swift, and odin are committed" becomes
  kotlin and swift.
- `.pi/contexts/extensions/explore.toml` — two `references` arrays list
  `odin.ts`, `odin-file-deps.ts`, `sample.odin` and `odin.wasm`. Let
  `/context-sync` regenerate rather than hand-editing.

Check after: `git grep -inw odin` outside `docs/plans` and `package-lock.json`
returns nothing. Beware that a case-insensitive `odin` also matches
`coding-agent`, which is why the word-boundary form is the one to trust.

Task F depends on a pattern that lives in a file this task deletes — see the note
under Task F. Read it before deleting, or land Task F first.

### Task R — test coverage for the AST layer

The largest standing risk in this area, independent of every task below.
`src/ast` is 11,467 lines; `find test -name '*.ts' | xargs grep -l "ast/\|explore"`
returns **2 files, 130 lines**. Every finding in the audit was found by hand
against real corpora, because nothing else would have caught them.

Not a separate project. Each task in Phases 1–4 lands with the smallest test that
fails if its logic breaks, per the validation strategy at the end. Task R is the
standing instruction to keep that discipline and to backfill the shared fixtures
those tests need — a small multi-language fixture tree, and one two-module fixture
repository per dep-resolution layout.

## Phase 1 — silent wrongness, local fixes

### Task A — stop hiding module-visible declarations

Findings 10, 14, 18. The single highest-payoff change in the audit.

`keepVisibility` (`src/ast/queries/outline.ts:39`) treats `internal` as private.
Measured effect: Swift 1,470/1,640 files (90%) print `No declarations`, Rust
348/753 (46%), Java 287/4,615 (6%), plus every C# `internal` type. Rust's own
adapter contradicts the filter — `rustExported()` (`languages/rust.ts:214`) counts
`internal` as exported.

1. `outline.ts:39` — when `includePrivate` is false, exclude only `private` (Swift
   `fileprivate`, Rust true-private, C#/Java/Kotlin `private`). Keep `internal`
   and `protected`.
2. `languages/go.ts:174` — `return goExported(name) ? "public" : "private";` maps
   Go's package-visible identifiers to `private`. Change to `"internal"`. Go has
   no file-private level; lowercase is the analogue of `pub(crate)`. Without this
   the step 1 change makes Go *worse*, since Go visibility is per identifier, not
   per type: `outline tsdb/agent/series.go` already prints 17 methods and zero of
   the five types that own them.

Validation: unit test per language asserting an `internal` declaration appears
with `includePrivate: false` and a `private` one does not. Add the Go
`memSeries`-shaped case (unexported type, exported method) explicitly.

Cache note: `src/file-injection/index.ts:19` and `extensions/explore/read/hook.ts:22`
both inject outlines with `includePrivate: false`, so injected content grows. It
stays deterministic per file content, so the cached prefix stays stable across
consecutive requests, but measure the size delta on a real session before
shipping — a Swift or Rust file that injected 3 lines may now inject 60.

### Task B — case-insensitive `discover` matching

Finding 25. `discover.ts:59-60` uses raw `startsWith` / `includes`; `fuzzyScore`
(line 66) compares raw characters; line 261 does raw `includes` on doc text.

Every language in the sweep capitalizes types and lowercases functions, so a
query returns half the surface: `substringName "queue"` finds `enqueue`,
`dequeue`, and the `queue` field but not `Queue` or `Priority_Queue`;
`prefixName "Outline"` in this repo finds four types and none of `outlinePath`,
`outlineRecursive`, `outlineFromIr`.

Case-fold both sides for `prefixName`, `substringName`, `fuzzyName`, and
`documentation`. Leave `exactName` exact. Keep the existing exact-prefix ranking
bonus so same-case hits still sort first.

Validation: one test per query kind asserting both casings return the same set,
and that same-case hits rank first.

### Task C — declaration-shaped sites show their signature

Finding 21. `makeSite` (`graph/relationships.ts:261`) always sets
`preview: linePreview(source, line)`, the raw source line at the declaration's
start — which for annotated code is the annotation:

```text
L33  implementation  inferred  @Internal
L35  implementation  inferred  @Internal
```

Neither row names the implementing type. 3,339 of 4,997 micronaut files have an
annotation-led top-level type; Kotlin and Swift are the same.

Pass an explicit preview for the three declaration-shaped call sites —
`heritageSites` (line 457), the type-heritage branch (519), and `override` (571)
— built from the decl's own signature slice
(`source.slice(startOffset, signatureEndOffset)`, whitespace-collapsed, capped at
80 chars, exactly what `candidateParts` in `format/relationships.ts:5` already
does). Leave calls and imports on `linePreview`; the raw line is right for those.

Extract the collapse-and-cap into one helper used by both formatters, since it
then has two call sites.

### Task D — bound `ast_search` per-match output

Finding 7. `formatMatchRows` (`format/ast-search.ts:10`) echoes `match.text` in
full and every binding in full. One Kotlin `@Composable\nfun $NAME($$$ARGS)` match
ran 117 lines; six matches came to roughly 6k tokens. `resultLimit` caps match
count, not match size, so it cannot help. The whole-result
`BoundedTextResultBuilder` cannot help either — one match floods before the
result-level cap engages.

1. Cap printed lines per match with head retention plus an elided count.
2. Never echo a multi-line metavariable capture verbatim. Print
   `$BODY = <27 lines>`. A capture the caller wrote `$$$` for is a span, not a
   value.

Validation: a test asserting a 200-line match prints a bounded row count and that
a multi-line binding prints a line count instead of its text.

### Task E — `context` stops printing type bodies twice

Findings 8 and 4.

`packTarget` (`queries/context.ts:265`) prefers the full body, then the
`methods` group (line 373) reprints every child body. `context
SplashAuthController` spent ~1,071 tokens on the class body then 2,090 of a 2,200
budget repeating the same eleven methods.

Rule: type-like target prints signature plus members; callable target prints its
body. Pass the target kind into `packTarget` and skip the body branch for
type-like targets, since the `methods` group covers them.

Same function, Finding 4: the `dependents` group derives type dependents from
callers of the type's methods matched by name, so a method named `render`
collects unrelated sites (`context ScrollableMarkdown` listed `renderFilterRow`).
Drop sites with `certainty === "ambiguous"` from the method-derived dependents
loop (line 378). Documented conservative behavior today, but wrong entries cost
budget that correct ones need.

## Phase 2 — file dependency resolution

The weakest area of the toolset. Four languages fail in four different
directions, and three of the four fixes want the same new primitive.

### Task F — resolved package edges and separate result budgets

Findings 17, 20 (wildcard imports), and the Go rough edges. Finding 24 originally
drove this and is retired with Odin, but the missing representation it exposed is
still real for C#, JVM wildcards and Swift.

Two defects share one cause: `FileDepResolution` (`adapter.ts:31`) can only say
`internal` (a file list), `external` (an opaque id), or `unresolved`. A resolved
in-repo *package* has no representation.

1. Add `{ kind: "package"; id: string; dir: string; fileCount: number }` to
   `FileDepResolution`, and a matching `FileDepHit` variant in
   `graph/file-graph.ts:12`. `boundedInternalPaths`
   (`languages/file-dep-util.ts:24`) returns it above `maxFiles` instead of
   `externalId`. Print it under the internal tree as
   `com/example/core/ (45 files)`.

   The defect `boundedInternalPaths` has today: nothing distinguishes "not in this
   repository" from "too large to list", and the threshold is all-or-nothing — 12
   files list in full, 13 vanish into `external:`. Measured on Odin before
   removal, 862 of 4,176 in-repo imports (20.6%) were mislabeled this way, which
   is the size of error to expect wherever a package exceeds `maxFiles`.

   Reference implementation note, because Task Q deletes the file: the deleted
   `odin-file-deps.ts` was the best-shaped resolver in the tree, and the parts
   worth copying were nearest-first candidate root ordering, an
   environment-variable root override resolved before repository scanning, and
   bounded directory expansion that stops at a file-count ceiling rather than
   walking the subtree. `csharp-file-deps.ts` (`indexPathSuffixes`) is the
   surviving example for the suffix-index half. Both patterns are recoverable from
   git history if the description is not enough.

2. Split the result budget in `collectForwardHits`
   (`graph/file-graph.ts:262`). One shared `hits.length >= resultLimit` gate in
   edge order lets externals crowd out internal edges: Go `deps` at
   `resultLimit: 20` spent 18 slots on `context`, `errors`, `fmt`, `io`,
   `log/slog`; C# spent 18 of 20 on namespace names. Give internal and package
   hits the full `resultLimit`, cap externals separately, and collapse the
   remainder to a count line. Go files routinely carry 15 stdlib imports.

Optional, same file, lower value: respect `//go:build` constraints in
`go-file-deps.ts`. Today `tsdb/head.go` reports all three mutually exclusive
`labels_*.go` variants plus both `head_chunks_other.go` and
`head_chunks_windows.go` — a dependency set that cannot exist in one build.
Emitting every variant is defensible; document it rather than fix it, and revisit
if it confuses callers.

### Task G — JVM cross-module resolution

Findings 6 and 20, the severest dep defect measured.

`sourceRootsFor` (`languages/jvm-file-deps.ts:91`) builds candidate roots from
ancestors of the importing file, that file's inferred source root, and the fixed
suffixes `<scopeRoot>/src/main/java` and `<scopeRoot>/src`. Nothing enumerates
sibling module source roots, so in any multi-module Gradle or Maven build an
A→B import cannot resolve.

Measured with `forwardEdges` over a 300-file micronaut sample: 183 internal edges
against 918 `io.micronaut.*` imports reported external — **16.6% resolved**, with
`io.micronaut.core.annotation.Internal` sitting at
`core/src/main/java/io/micronaut/core/annotation/Internal.java`. Kotlin shares the
resolver; on ktor (layout `<module>/jvm/src/<package>/…`, matching none of the
hardcoded suffixes) it is 7 edges against 841 — **0.8%**.

Replace source-root guessing with a package-path suffix index, the strategy
`csharp-file-deps.ts` already uses:

1. Once per scope root, memoized in `host.memo`, walk owned files and index each
   by the package path implied by its directory.
2. Resolve a type import to the file whose indexed package matches and whose
   basename matches; fall back to any file in that package directory declaring
   the type (Kotlin does not require filename to equal type name — Finding 6
   defect 3).
3. Resolve a wildcard or lowercase-tail member import to the package directory,
   emitted as a Task F package edge. This also fixes Finding 6 defect 2, where
   any import whose last segment starts lowercase is hard-coded external —
   idiomatic for every Kotlin Composable, extension function, and top-level
   `val`.
4. Delete `sourceRootSuffixes`. A fixed list cannot track real layouts.

Validation: fixture repo with two modules, asserting a cross-module type import,
a Kotlin top-level function import, and a Kotlin file whose name differs from its
type all resolve internal. Cap index work with the existing traversal budgets.

### Task H — C# namespace imports resolve to a package

Finding 17. `resolveCsharpFileDep` returns `internalPaths([file])` — a single
file — though a `using` imports a whole namespace. On `ILibraryManager.cs` (20
usings) the only 4 internal edges came from `using X = Fully.Qualified.Type;`
aliases; all 12 plain first-party namespace usings were reported external. The
output contradicts itself: `MediaBrowser.Controller.Entities` appears as an
external id while also being the directory that supplied the 4 internal files.

Exact inverse of Swift Finding 11: Swift over-expands a module to every file, C#
under-resolves a namespace to one. Resolve a `using` to the namespace's directory
as a Task F package edge; keep alias usings resolving to their single file.

### Task I — TypeScript workspace packages

Finding 1. `resolveTypescriptFileDep` resolves relative specifiers and tsconfig
`paths` aliases, then falls through to `externalId`. This repo has no `paths`
mapping — workspace packages resolve through the npm workspaces symlink, which
the resolver never consults, so `reverse_deps packages/agent/src/index.ts`
reports nothing while `references` resolves the same specifier. `references/pi`
proves the `paths` branch works, so only the workspaces fallback is missing.

Build a `name → dir` map from the root `package.json` `workspaces` globs,
memoized in `host.memo`, and resolve the matched package entry with the
`types`/`module`/`main` logic in `typescript-package-surface.ts`. Roughly 40
lines. Do not follow the `node_modules` symlink: a path containing
`/node_modules/` fails `host.ownsPath` and would duplicate the real file.

### Task J — Swift module imports stop expanding to whole modules

Finding 11. `resolveSwiftFileDep` expands `import SomeModule` to every file in
the module directory, up to 500 files, which breaks `deps` and makes
`impact --mode dependents` unusable on a 1,642-file corpus.

With Task F in place this is small: return a package edge for the module
directory instead of a file list. Then, in order of remaining value:

1. Exclude `Package.swift` and system module directories.
2. Cap file-importer lists in `format/impact.ts`, symbol callers first — the
   information a caller wants is the symbol edge, not 500 file edges.

Deriving Swift file edges from symbol resolution is the principled fix and stays
out of scope; the package edge removes the harm.

## Phase 3 — declaration modeling

### Task K — Rust impl blocks become real containers

Finding 13. `IMPL_ITEM` (`languages/rust.ts:397`) emits impl methods as flat
file-scope siblings and, for trait impls only, adds a marker decl with
`kind: "class"`, `name` = the target type, hardcoded `visibility: "public"`, no
children, and a span covering the whole impl.

Four symptoms, one cause:

- `context LinkedList` returned 5 candidates — the real struct plus 4 markers all
  named `LinkedList`. About 1,248 trait impls in tokio, ≈13% of Rust
  declarations, are phantoms shadowing real names.
- The marker has no body offset, so `outline` prints its entire span — the whole
  impl body — then reprints the same methods as siblings.
- The hardcoded `public` plus Task A's old filter inverted output: default
  `outline` of `linked_list.rs` showed only the 5 markers and hid `LinkedList`,
  `Link`, `Pointers`, and every method.
- Inherent impls (1,253 in `tokio/src`) emit no container at all, so methods
  float ownerless — outline listed two indistinguishable `pub(crate) fn new()`.

The IR is correct underneath: `callers push_front` reports
`method LinkedList.push_front`. This is modeling and formatting only.

1. Name the marker for what it is: `impl Default for LinkedList`, `impl LinkedList`.
2. Nest the impl's methods as the marker's `children` instead of file-level
   siblings. `methodOwner` already equals the target, so `qualifiedName` stays
   `LinkedList.push_front` and `callers`/`impact` keep working.
3. Inherit the impl's real visibility instead of hardcoding `public`.
4. Set the signature end to the body's start so `outline` prints the impl header,
   not the body.
5. Emit the same container for inherent impls.

Keep `bases: [trait]` — `implementations` finds impls through it and
`heritageSites` accepts `class`. Renaming does not break the "never list the base
as its own implementor" guard, which compares `decl.name` to the base name.

Validation: `outline` of a file with one inherent and one trait impl shows two
containers with nested methods and no duplicated bodies; `context` on the target
type returns one candidate.

### Task M — top-level calls get an owner

Finding 2. Call extraction runs per declaration body, so a top-level statement
such as `const leaf = createLeafBuilder(extractCalls, heritageBases);` produces no
`CallSite` at all. `callers createLeafBuilder` returns `No relationship sites`
while five adapters call it and `ast_search` finds all five. The output reads as
"no callers" rather than "not tracked".

Affects TypeScript, Kotlin, Swift, Rust, and Go. Java and C# are immune by syntax.

1. Add `fileCalls: CallSite[]` to `ExtractResult` (`adapter.ts:25`) and `FileIr`
   (`ir.ts`), threaded through `engine.ts`.
2. In `graph/relationships.ts:425`, add a second pass over `bundle.ir.fileCalls`
   with a synthetic `DeclRef` built locally. Keep it out of the IR decl tree so it
   never reaches `outline`, `discover`, or declaration counts. Output is
   unaffected: `formatSiteRow` prints path, line, kind, and preview, never the
   owner.
3. One line per adapter: run `extractCalls` on the tree root. `walkBodyNodes`
   already skips nested scopes.

## Phase 4 — new capability

### Task N — Go interface implementers by method set

Finding 15, the largest single item and the one most likely to be deferred.

`implementations Appender` pinned at `storage/interface.go:413` returned **1**
result, found only because that file textually mentions `storage.Appender`.
Ground truth: 12 distinct types declare `Commit() error` and 7 more embed
`storage.Appender` — recall ≈1/12. Unpinned it is also misdirected: 7 *methods
named* `Appender` (constructors returning the interface) rank above the interface,
because Go shares one lookup space for method and type names.

`heritageSites` (`graph/relationships.ts:441`) matches
`ref.decl.bases.includes(baseName)`, which in Go only catches embedding.

Add method-set matching for interface targets: build a per-scope index of type
name → owned method names from data already in the IR (`qualifiedName` owners),
expand embedded interfaces transitively, and report types whose method set covers
the interface's. Mark them `inferred`, since a syntactic match cannot check
signatures.

If this is deferred, do the cheap half now: state the limitation in the output
footer so "1 result" is not read as "one implementer". A wrong count is worse
than a stated gap.

Related, cheap, same file: `implementations` prints same-file impls without the
`inferred` label while cross-file impls carry it, which reads like a confidence
difference that does not exist. Make the labeling uniform.

### Task O — Rust `deps` stops dropping silently

`use crate::loom::cell::UnsafeCell` vanished from `deps` output — neither internal
nor external. The target is an inline `pub(crate) mod cell { … }` inside a
cfg-gated re-export at `tokio/src/loom/std/mod.rs:14-15`, so path-to-file
resolution finds nothing.

On an unresolvable `use` path, fall back to the longest existing module prefix
(`crate::loom` → `loom/mod.rs`) rather than dropping the edge. A silent drop is
the wrong failure mode: the reader cannot tell a missing edge from an absent one.

## Phase 5 — grammars

### Task P — re-pin C#, report the rest upstream

**Confirmed viable.** Finding 16. The pinned grammar has no collection-expression
support at all:

```text
int[] a = [];       → parse error                              (flagged)
int[] a = [1];      → element_binding_expression, hasError false (silent)
int[] a = [..b, 1]; → element_binding_expression, hasError false (silent)
```

`[1]` fits the null-conditional indexer rule, so the tree looks plausible and
nothing warns; `[]` has no fallback and errors. 123 jellyfin files contain a bare
`[]` against 118 degraded — one construct explains the entire 5.6% degradation,
the worst rate measured. Another 110 files (306 occurrences) are silently wrong,
so ~11% of the corpus misparses and half of that is unflagged.

`@vscode/tree-sitter-wasm@0.3.1` is the latest published version, so no bump
helps. Move `c_sharp` to a `release`-sourced pin from
`tree-sitter/tree-sitter-c-sharp` in `grammars/manifest.json`, the mechanism
`swift` already uses.

Verified upstream, 2026-07-31: `tree-sitter/tree-sitter-c-sharp` master has
`collection_expression` at `grammar.js:1910`, `spread_element`, and an explicit
`[$.collection_expression, $.list_pattern]` conflict declaration. Latest tag
`v0.23.5` (2026-04-14); the crate shows 4.7M downloads, so it is well exercised.
The vscode bundle is not a different grammar, only an old one.

**Report upstream, change nothing here:** Findings 3, 5, 9, 12, 19 — the
TypeScript `f<typeof import("x")>()` type query, Kotlin one-line class bodies, the
four `tree-sitter-swift` 0.7.3 bugs, and Java annotated varargs. Java verified
still broken on master, 2026-07-31: `spread_parameter: seq(optional($.modifiers),
$._unannotated_type, '...')` has no annotation slot before `...`.

Two of these deserve a note in the report, because a plausible tree with no
warning is worse than a hard failure: the C# `[1]` misparse and the Swift `!//`
adjacent-comment variant.

## Rust core engine — evaluated and declined

Considered moving the AST core to Rust. Declined. Recorded so it is not reopened
without new information.

What it would buy:

- Grammar sourcing becomes `cargo add tree-sitter-<lang>`: versioned crates, no
  wasm build, no container. The strongest argument, and it addresses the one real
  pain point in `build-grammars.ts`.
- Native parse speed plus rayon parallelism.
- Direct access to the Rust tooling ecosystem, though the biggest piece is already
  consumed here as `@ast-grep/wasm`.

Why it loses:

- **It fixes none of the findings.** Of Findings 1–25, nine are grammar-related
  and the rest are language-agnostic logic bugs in *our* code: the visibility
  filter, four broken dep resolvers, Rust impl modeling, top-level call ownership,
  case-sensitive matching. A rewrite reproduces every one verbatim. The
  highest-impact fix in this plan is one line in `outline.ts:39`.
- **Performance was never the bottleneck.** Whole-corpus sweeps: 5,000 Java files
  in 2,370 ms, 726 Go files in 2,169 ms, 790 Rust files in 2,062 ms. Real tool
  calls touch a package, not a corpus.
- **Scale versus safety net.** `src/ast` is 11,467 lines (before Task Q removes
  ~550) across an IR, queries, formatters, dep resolvers and a graph layer;
  `extensions/explore` adds 1,659. Coverage is 130 lines across 2 files.
- **Distribution.** pi is a TypeScript harness shipped via npm. A Rust core means
  a NAPI or IPC boundary plus per-platform prebuilt binaries, and the extension
  surface stays TypeScript regardless.

If wasm build friction is the real driver, the cheaper answer is moving more
grammars to `source: "release"` prebuilt assets the way `swift` does. Revisit Rust
only for persistent whole-repo indexing, where native speed and parallelism start
to matter.

## Not doing

- Per-configuration IR for Go build tags. Emit every branch.
- Deriving Swift file edges from symbol resolution (Task J note). The package edge
  removes the harm at a fraction of the cost.
- Owning any grammar build. The Odin fork was scoped in detail and then dropped
  with Odin support itself; see the note below.
- Rewriting the AST core in Rust. See the evaluation above.
- Finding 4's full fix. Dropping ambiguous sites (Task E) is enough; ranking
  method-derived dependents by certainty is speculative until someone reports it.

### Dropped: owning the Odin grammar

Researched 2026-07-31 and scoped as a fork before Odin support was removed
outright. Kept as a paragraph in case Odin returns, so the research is not
repeated:

`tree-sitter-grammars/tree-sitter-odin` master is `d2ca8ef`, 2025-01-12 — one
commit past our pin, roughly 18 months stale. The org is active (87 repos, pushes
within days) but this repo has no working maintainer: 6 open PRs and 13 open
issues, newest PR 2026-07-20, none merged. No viable alternative fork exists
(`ap29600` dead since 2023-05, `MineBill` self-declared unmaintained, `firstrow` a
`go.mod` tweak, `amaanq` the same SHA). nvim-treesitter pins master; Helix pins
PR #26's *unmerged* branch. The Rust crate is the same stale 1.3.0, so no language
choice routes around it. Two of the nine gaps were new Odin features rather than
bugs — `[dynamic; N]T` (`dev-2026-04`, deprecates `container/small_array`) and
`for init; x in y` (`dev-2026-03`, already implemented in open PR #34 in four
lines). Odin ships monthly, so drift is continuous and ownership would have been
permanent, not one-time.

## Validation strategy

Unit tests, not corpus runs, for everything above. The corpora produced the
findings; they are too slow and too unstable to gate a commit on.

Each task needs the smallest test that fails if the logic breaks:

- A, B, D, E: single-file fixture, assert on formatted output.
- C, K, M, N: fixture plus a relationship query, assert on site rows.
- F–J: two-module fixture repositories under `test/fixtures`, one per language
  layout being fixed.
- Q: `grammars.test.ts` still passes with seven languages, and `git grep -inw odin`
  comes back empty outside `docs/plans` and `package-lock.json`.

Re-measure against the real corpora only after Phase 2 and Phase 3 land, using
the harness in `/tmp/audit-harness/` (`scan`, `vis`, `dep-rate`, `bisect`,
`errnodes`, driven by `AUDIT_ROOT` / `AUDIT_EXT` / `AUDIT_PIN` / `AUDIT_FILES` /
`AUDIT_PREFIX`). `dep-rate` is the one that matters: it reports the first-party
import resolution rate that Tasks F–J exist to move.

To run any harness file, copy it out of `/tmp/audit-harness/` into
`packages/agent/test/tmp-audit/`, then delete that directory before the turn ends
or the automatic `check:ts` run fails on the missing `AUDIT_ROOT`. The Odin-only
harness files (`o-repro`, `o2`, `o3`, `o4`, `o5`) are now dead weight.
