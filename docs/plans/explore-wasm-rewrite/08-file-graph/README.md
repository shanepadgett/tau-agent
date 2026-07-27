# Task 08 — File dependency graph, `deps` and `reverse_deps`

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
| **TypeScript / TSX** | Relative/`./`/`../`: try as-is + extensionless + `.ts` `.tsx` `.d.ts` `.js` `.jsx` + `/index` with those ext; map `.js`→`.ts` / `.jsx`→`.tsx` when that file exists. | Bare specifier (not relative) → external id = package name (strip subpath after first unscoped segment or `@scope/pkg`). | No `node_modules` walk. No tsconfig `paths`. |
| **Go** | Walk up from `fromPath` for `go.mod`; read module path. If specifier has that prefix (or is a `./`/`../` rare path), map to dir under module root; **all** `*.go` in that package dir except `*_test.go` → internal paths. | Specifier with no dot in first path element (stdlib), or module path not this module and not a `replace`/`workspace` local dir → external id = specifier. | No GOPATH. No remote fetch. |
| **Rust** | Crate root = nearest `Cargo.toml` ancestor under scope. Resolve `crate::a::b` / `self::` / `super::` to `a/b.rs`, `a/b/mod.rs`, or `a.rs` style module files from current file’s module path. `mod name;` in current file → `name.rs` / `name/mod.rs` beside file or in its directory. | `use` of other crates / unresolved paths → external id = leading crate/ident. | v1 module-file graph, not name resolution. |
| **Java** | Specifier → strip `.`\*; convert dots to path segments; search under scope for `.../Segment.java` (type) or package directory `.../segment/*.java` (wildcard / package-only). Also try common roots relative to scope: `src/main/java`, `src`. | `java.*` / `javax.*` / no file hit → external id = package or type name. | First existing file set wins; do not leave scope. |
| **Kotlin** | Same as Java with `.kt` / `.kts`; also try `src/*/kotlin`, `src/*/java`. | `kotlin.*` / `java.*` / `javax.*` / miss → external. | okio-style source sets. |
| **C#** | `using` namespace (trim `global` / `static` / `;`) → under scope, all `.cs` files whose namespace declaration equals that namespace or is a child prefix match only when the using is exact namespace equality (exact match on file namespace). | No file with that namespace → external id = namespace. | Namespace ≠ file; fan-out to matching files is the honest v1. No assembly resolver. |
| **Swift** | Module name → under scope, `Sources/<Module>/`, `Source/<Module>/`, or directory named `<Module>` with `.swift` files; all those `.swift` files → internal. | No module dir → external id = module name. | Good enough for `swift-collections` layout. |
| **Odin** | Relative path → `.odin` / dir package under `dirname(fromPath)`. Collection `name:pkg/path` → package dir under a collection root found in scope (`./name`, ancestors, scope root, or Odin root with both `core/`+`base/`; `ODIN_ROOT` when inside scope). All direct `*.odin` in that package dir → internal. | Collection/package not present under scope → external id = full specifier. | No `-collection` flag parse in v1. Stdlib outside scope stays external (honest for game repos). |

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
