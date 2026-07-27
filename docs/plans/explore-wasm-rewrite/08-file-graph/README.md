# Task 08 — File dependency graph, `deps` and `reverse_deps`

## Status: DONE (as built — read before touching resolvers or impact file sections)

Shipped. Normative for downstream work is **disk + this banner**, not the first-draft resolve table alone.

**As built:**

- `ExploreFileGraph` in `ast/graph/file-graph.ts`; tools `deps` / `reverse_deps`; every programming adapter has `fileDeps` + `resolveFileDep` (siblings: `*-file-deps.ts`).
- **Token law (post-LIVE-PROVE, aligned with ast-bro):** one import → **0 or 1 internal file** when a precise hit exists, else a **single external id**. Never expand one import into a crowd of files.
  - **C#:** suffix + `namespace.Type` FQN index, `pickClosest`, framework namespaces always external; bare `using Ns` → external id (not every file in the namespace).
  - **Java/Kotlin:** type path → one file; `pkg.*` and package-only → external package id (no directory dump).
  - **TypeScript:** relative resolve + **tsconfig/jsconfig `paths`/`baseUrl`** (extends merge; defining-config baseDir); bare miss → package external. JSONC must not strip block comments with a regex that eats `"./*"`.
  - **Odin:** collection/relative package files; **fat packages** (>12 files, e.g. `base:runtime`) → external collection id via `boundedInternalPaths`.
  - **Go/Rust/Swift:** as adapters on disk; Go may still list package `*.go` files (package = multi-file unit).
- Shared helpers: `file-dep-util.ts` (`boundedInternalPaths`, walk/index utils). Graph/tools stay language-blind.
- `impact` file sections call `forwardEdges` / `reverseDeps` only — do not reintroduce namespace fan-out in composites.

## Cold start

Fresh window: read [`../COLD-START.md`](../COLD-START.md), [`../LIVE-PROVE.md`](../LIVE-PROVE.md), this file, deps/reverse-deps specs + system cache section, then `FileIr.imports`, `ast/adapter.ts`, and every `ast/languages/*` adapter. **No new tests.** Register tools. Live per Done when. `check:ts` green.

Depends on: 03 and 04 (every programming-language adapter exists before graph tools ship).

## Goal

Session file-import graph plus the two file-scoped tools. **Every registered programming language** gets real resolve rules and live proof — not TS-only with capability errors elsewhere. Markdown stays out (no file imports). Register when they work. This graph also backs `impact` sections 2/4/5 (task 10).

Specs: `explore-specs/graph/deps.md`, `explore-specs/graph/reverse-deps.md`, `explore-specs/cross/system.md` (shared cache).

## Files

```text
packages/agent/extensions/explore/ast/adapter.ts          (FileDepHost + resolveFileDep hook)
packages/agent/extensions/explore/ast/graph/file-graph.ts
packages/agent/extensions/explore/ast/tools/deps.ts
packages/agent/extensions/explore/ast/tools/reverse-deps.ts
packages/agent/extensions/explore/ast/languages/*.ts      (fileDeps: true + resolveFileDep for each programming language)
```

Sibling under `languages/` allowed when a resolver is large (same pattern as `typescript-package-surface.ts`).

## Language coverage law (this task)

- Shared `file-graph.ts` / tools: **zero** language ids, extensions, package layouts, or import syntax.
- Each programming-language adapter: `capabilities.fileDeps: true` and a required `resolveFileDep` implementation.
- Markdown (and any future non-code adapter without imports): `fileDeps: false` → capability-unavailable only for that path. That is the sole honest exception.
- Shipping graph tools that work on TS and error on Go/Rust/Java/… is a stop-ship for this task.

## Resolve hook (adapter-owned)

Add to the adapter surface (required when `fileDeps: true`):

```ts
type FileDepResolution =
  | { kind: "internal"; paths: string[] } // absolute files, sorted unique
  | { kind: "external"; id: string }      // package/module/collection id for display
  | { kind: "unresolved" };

type FileDepHost = {
  readonly cwd: string;
  /** Scope root for this query (see below). Resolvers must not walk above it unless noted. */
  readonly scopeRoot: string;
  pathExists(path: string): Promise<boolean>;
  isFile(path: string): Promise<boolean>;
  readDir(path: string): Promise<string[]>; // basenames; empty if missing
  /** True when path is a registered source file this graph should consider. */
  ownsPath(path: string): boolean;
};

// on GrammarAdapter / SourceAdapter when fileDeps:
resolveFileDep(
  fromPath: string,
  specifier: string,
  host: FileDepHost,
  signal: AbortSignal,
): Promise<FileDepResolution>;
```

Shared graph code: load IR → for each `ImportRef.specifier` call `adapter.resolveFileDep` → record edges. Never interpret specifiers itself.

### Shared edge model (`file-graph.ts`)

```ts
type FileGraphEdge =
  | { kind: "internal"; from: string; to: string } // file → file
  | { kind: "external"; from: string; id: string };
```

Multi-file package resolve (Go package dir, C# namespace hit list, etc.) fans out to one internal edge per target file.

## Scope root (shared, for reverse index + resolver bound)

Tools take only `path` / `depth` / `resultLimit` (specs). Graph picks scope once per call:

1. If `path` is under session `cwd`, scope root = `cwd`.
2. Else nearest ancestor containing `.git`.
3. Else `dirname(path)`.

Host passes that `scopeRoot` into every `resolveFileDep`. Reverse index: scan **owned source files under scope root** (budget-aware engine scan, same ignore/traverse as outline), resolve forward edges, build reverse map. Cache reverse index per scope root for the session; invalidate per path on mutation bus (hook wired task 13).

`deps` needs no scan beyond the seed file’s IR + resolve (and BFS targets at `depth > 1`).

## Graph cache

- Forward edges per file: lazy from IR + resolve, keyed by path, drop on content/mutation invalidation.
- Reverse index: per scope root, built on first `reverse_deps` / `impact` need.
- `deps` with `depth > 1`: BFS over internal forward edges, cycle guard, depth labels.
- External edges: never traversed for deeper BFS; listed at depth of the importing file only.

## Per-language v1 resolve rules (honest, corpus-useful)

No typechecker. No network. Stay inside `scopeRoot` for internal hits.

| Language | Internal | External | Notes |
| --- | --- | --- | --- |
| **TypeScript / TSX** | Relative/`./`/`../` (ext + index + js→ts map). **tsconfig/jsconfig `paths`/`baseUrl`** (nearest config, `extends` merge, longest pattern first, defining-config baseDir). | Bare miss → package name. `node:` / `data:`. | No `node_modules` walk. JSONC: do not regex-strip `/*` (breaks `"./*"`). |
| **Go** | `go.mod` module prefix → package dir; **all** non-`_test.go` in that dir. | Stdlib / other module → specifier. | Package multi-file is intentional. |
| **Rust** | `crate`/`self`/`super`/`mod` → module files. | Other crates → leading ident. | v1 module-file graph. |
| **Java** | `pkg.Type` → one `.java` under source roots. | `java.*`/`javax.*`/…; **`pkg.*` and package-only** → package id; type miss → external. | **No** package-dir file dumps. |
| **Kotlin** | Same as Java with `.kt` (+ `.java`); multiplatform source roots. | `kotlin.*`/`java.*`/…; wildcards/package-only external. | okio-style roots. |
| **C#** | `using` / `using static` → at most **one** file via path-suffix + `namespace.Type` FQN + `pickClosest`. | Framework (`System`/`Microsoft`/…); bare namespace miss → namespace id. | **Never** “all files in namespace.” No assembly resolver. |
| **Swift** | Module dir → `.swift` files under module. | No module dir → module id. | Fat modules: prefer external id if live corpus dumps (same spirit as Odin bound). |
| **Odin** | Relative / `collection:pkg` → direct `*.odin` in package dir when small. | Missing collection; **>12 package files** → collection id (`boundedInternalPaths`). | No `-collection` flag parse. |

Unresolved: omit from output edges (do not invent). Empty internal+external after resolve → one-line empty per spec.

## Output

Per spec: dependent/importing files as a small indented tree when factoring helps, depth labels when `depth > 1`, external package edges grouped last, one-line empty, omission footer only when `resultLimit` cut. No stats, no timing.

## Registration

Wire `deps` and `reverse_deps` in Explore `index.ts` when live. Thin tools: schema + path checks + graph call + bounded emit.

## Done when

After `/reload`, real `deps` / `reverse_deps` per [`../LIVE-PROVE.md`](../LIVE-PROVE.md) on **each** programming language:

| Lang | Corpus | Prove |
| --- | --- | --- |
| TS/TSX | `pi` and/or `excalidraw` | Relative internal edges + bare external; `depth > 1` BFS on a hub file |
| Go | `go-tui` | Module-internal package files; stdlib external |
| Rust | `ast-bro` | `crate::` / `mod` internal file edges |
| Java | `guava` | Package/type path → `.java` files; `java.*` external |
| Kotlin | `okio` | Same family as Java on `.kt` |
| C# | `Avalonia` | Namespace → implementing `.cs` files or external |
| Swift | `swift-collections` | Module dir → `.swift` files |
| Odin | `Odin` | Relative internal and/or `core:` external |

Also: Markdown or other non-`fileDeps` path → clear capability error. Monorepo TS optional extra only.
