# Task 09 — `callers`, `callees`, `references`, `implementations`

## Status: DONE (as built — read this before task 10/11)

Shipped design **diverged** from the long “free-floating `collectOccurrences`” draft below. Normative for downstream work is **what is on disk**, not the historical architecture section.

**As built:**

- IR additives on every programming extract: `Decl.calls: CallSite[]`, `Decl.bases: string[]`, `ImportRef.bindings: ImportBinding[]` (`ast/ir.ts`). Adapters fill them at extract time; shared code never sees tree-sitter node types.
- One query: `queryRelationships` in `ast/graph/relationships.ts` — ops `callers` | `callees` | `references` | `implementations`. Task 10 calls **this function**, not the four tools.
- Four thin tools in `ast/tools/relationships.ts`, registered in `index.ts` via `engineFor` + `graphFor`.
- Format: `ast/format/relationships.ts`. Certainty: `exact` | `inferred` | `ambiguous`. Same-name overloads collapse to one bind group (no competitor spam). Receiver-bearing calls never unique-global `exact`.
- Callers/callees/references/implementations are **depth 1** (no BFS on symbol edges). Markdown `callEdges: false`.
- There is **no** `collectOccurrences` / `occurrencesForFile` seam. Do not add one for task 10. Task 11 needs its own engine tree access if it needs live `Tree`s.

Historical sections below kept for archaeology; do not re-implement them.

## Cold start

Fresh window: read [`../COLD-START.md`](../COLD-START.md), [`../LIVE-PROVE.md`](../LIVE-PROVE.md), this file, `explore-specs/graph/relationships.md` (full), identity + file-graph + engine + `ast/adapter.ts`. **No new tests.** One pipeline, four tool names. Live per Done when. `check:ts` green.

Depends on: 05, 08.

## Goal

Four relationship tools over **one** shared query. Register when they work. There is **no** `tests` tool (`stripped.md`).

Spec: `explore-specs/graph/relationships.md` — params and agent-visible output are normative. This README is normative for architecture, seams, operation filters, certainty, and language coverage.

**Coverage law:** every programming adapter with `callEdges: true` ships a real `collectOccurrences`. Markdown stays out. Shipping tools that work on TS and capability-error on Go/Rust/Java/… is a stop-ship.

## Files

```text
packages/agent/extensions/explore/ast/adapter.ts              Occurrence* types + collectOccurrences hook
packages/agent/extensions/explore/ast/engine.ts               occurrencesForFile (Tree never escapes)
packages/agent/extensions/explore/ast/graph/occurrences.ts   scope scan → plain occurrence hits
packages/agent/extensions/explore/ast/graph/relationships.ts one query fn + operation enum (task 10 calls this)
packages/agent/extensions/explore/ast/format/relationships.ts
packages/agent/extensions/explore/ast/tools/relationships.ts four thin tool defs (shared execute core)
packages/agent/extensions/explore/ast/languages/tree.ts      optional generic walk helper (callback-only; no node-type names)
packages/agent/extensions/explore/ast/languages/*.ts         collectOccurrences on all eight programming adapters
packages/agent/extensions/explore/index.ts                   register the four tools (engineFor + graphFor)
```

Sibling under `languages/` allowed when a table is large (`typescript-occurrences.ts`, etc.) — same pattern as file-deps. Prefer inline until a file hurts.

Four tools, one implementation. Do not write four pipelines (anti-pattern 5).

---

## Architecture (locked)

```text
tool (callers|callees|references|implementations)
  → resolveTarget (task 05) under scope path
  → stop on candidates / notFound / outside scope / non-directory
  → relationships.query(op, resolved, scope, graph, limit, signal)
       inbound ops (callers|references|implementations):
         occurrences.scanScope(name) → hits
         certainty per hit via file graph + scope name index
         filter by op + target DeclKind
         implementations may add override sites from IR
       outbound op (callees):
         occurrences in target span only (defining file)
         resolve each hit name outward (identity / scope index)
         filter by op + target DeclKind
  → format → bounded-text-result (complete-block + temp overflow)
```

Shared modules (`graph/`, `format/`, `tools/`, `engine.ts`) name **zero** tree-sitter node types, language ids, extensions, or import syntax. Language knowledge lives only on adapters.

### Why not four pipelines

Operation is a filter + one inverted scan mode (`callees`). Certainty, budgets, formatting, and target resolution are identical. Task 10's `impact` imports the query function, not tools.

---

## Seams

### 1. Adapter hook (`ast/adapter.ts`)

IR has declarations and imports only — no identifier occurrences. Relationship scan needs a second, filtered tree walk. Follow the `resolveFileDep` precedent:

```ts
export type OccurrenceKind =
 | "call" // name in callee position of an invocation
 | "construct" // name in construction / composite-literal type position
 | "typeUse" // name in a type position that is not heritage/impl
 | "implementation" // name in extends/implements/impl-trait/conformance/embedding
 | "import" // name bound at an import site
 | "reExport" // name at a re-export site
 | "reference"; // residual matching identifier (value use, assign, pass, …)

export type Occurrence = {
 kind: OccurrenceKind;
 /** Bare identifier text as it appears in source. */
 name: string;
 /** 1-indexed. */
 line: number;
 /** UTF-16 offsets into `source` (decision 12). */
 startOffset: number;
 endOffset: number;
};

/** Filters are ANDed. Omitting `name` = every classified name node (callees body scan). */
export type OccurrenceFilter = {
 name?: string;
 /** Keep occurrences whose startOffset lies in [startOffset, endOffset). */
 startOffset?: number;
 endOffset?: number;
};

export type OccurrenceCollector = (
 tree: Tree,
 source: string,
 filter: OccurrenceFilter,
) => Occurrence[];

// On GrammarAdapter, next to resolveFileDep:
/** Required when `capabilities.callEdges` is true. */
readonly collectOccurrences?: OccurrenceCollector;
```

Rules:

- Each adapter owns **both** halves: which node types are name leaves for its grammar, and parent/field → `OccurrenceKind`.
- Shared code never writes `identifier`, `call_expression`, `impl_item`, etc.
- Emit the **name leaf** span (the identifier), not the whole call/heritage node.
- `name` on the occurrence is always the bare leaf text (`foo` from `obj.foo()`, `Foo` from `pkg.Foo`, last segment of scoped type idents when the leaf is only the tail — prefer the leaf the grammar exposes as the identifiable name node).
- Do not emit the target declaration's own name node at its define site (skip when the name node is the declaration's name field). Defining-file hits that are real uses inside the same file stay.
- `SourceAdapter` (Markdown): no hook. `callEdges: false`.
- Runtime: engine treats missing `collectOccurrences` while `callEdges: true` as a programming error (throw). Do not soft-skip that adapter.

Optional walk helper in `languages/tree.ts` (or a tiny `graph`-adjacent helper used only by adapters): cursor/walk over named nodes, adapter supplies `isNameNode` + `classify(nameNode) → OccurrenceKind | undefined`. Helper holds **no** grammar type strings.

### 2. Engine method

```ts
// ExploreEngine:
occurrencesForFile(
  path: string,
  filter: OccurrenceFilter,
  signal: AbortSignal,
): Promise<{ path: string; occurrences: Occurrence[]; parseDegraded: boolean }>;
```

Mechanism:

1. Resolve path, load bytes (same decode as IR).
2. Resolve adapter; if not grammar or `callEdges` false → return empty occurrences (caller skips). Missing collector with `callEdges` true → throw.
3. Parse with the engine's parser lifecycle (same as `buildIr`).
4. `adapter.collectOccurrences(tree, source, filter)`.
5. `tree.delete()` in `finally`.
6. Return plain data. **Tree never leaves the engine.**

No occurrence cache. Scope scan's cheap `source.includes(name)` prefilter (when `name` set) keeps parse volume down. Add caching only if live use proves it slow.

Do not overload `sourceForFile` / IR cache to retain trees.

### 3. Scope occurrence scan (`graph/occurrences.ts`)

```ts
type OccurrenceHit = Occurrence & {
  path: string; // absolute
  parseDegraded: boolean;
};

// name-filtered inbound scan across scope directory
scanNameOccurrences(engine, scopeDir, name, signal): AsyncGenerator<OccurrenceHit> / or buffered collect with budgets
```

For each `scanSources` file:

1. Adapter missing or `callEdges === false` or no collector → **skip file** (not an error). Multi-language scopes with Markdown/docs must still work.
2. When filter has `name`: skip file if `!source.includes(name)` (byte/string prefilter on decoded source).
3. Else `engine.occurrencesForFile(path, { name }, signal)`.
4. Honor scan budgets / abort; surface limit in query result footers.

Inbound tools always pass `name: target.decl.name` (bare). Dotted target names resolve via identity first; occurrence match is bare `decl.name` (method `foo` matches `foo` call sites). Do not string-match `Owner.foo` in source.

### 4. Query module (`graph/relationships.ts`)

```ts
type RelationshipOp = "callers" | "callees" | "references" | "implementations";

type RelationshipSite = {
  path: string;
  line: number;
  kind: OccurrenceKind | "override"; // override = IR method site, not a tree occurrence kind
  name: string;
  preview: string; // trimmed exact source line of the site
  certainty: "exact" | "inferred" | "ambiguous";
  /** Present when certainty === "ambiguous". Bounded competitor decls. */
  competitors?: Candidate[];
};

type RelationshipResult =
  | { kind: "resolved"; target: …; sites: RelationshipSite[]; …budgets/omissions }
  | { kind: "candidates"; candidates: Candidate[] }
  | { kind: "notFound" }
  | { kind: "error"; message: string }; // non-directory, outside scope, callEdges unavailable on target language
```

Single exported `queryRelationships(...)`. Tools and task 10 call this.

---

## Target DeclKind groups (IR vocabulary — not language ids)

```ts
function isTypeLike(kind: DeclKind): boolean {
  return (
    kind === "class" || kind === "interface" || kind === "struct" ||
    kind === "enum" || kind === "typeAlias" || kind === "object" ||
    kind === "namespace" || kind === "module" || kind === "package"
  );
}
function isCallableLike(kind: DeclKind): boolean {
  return kind === "function" || kind === "method" || kind === "constructor" || kind === "operator";
}
```

Everything else (variable, property, field, constant, enumMember, …) is **value-like**.

---

## Operation filters (normative)

Filters run on classified occurrences. Adapters only classify; they do not know which tool is running.

### `callers` (inbound)

| Target kind | Keep occurrence kinds |
| --- | --- |
| callable-like | `call` |
| type-like | `construct`, `implementation` |
| value-like | `call`, `reference` |

Spec: call sites; for types, constructions + implementors. `implementation` occurrences of a type name are the implementor/heritage sites (the name appears in someone else's extends/impl clause).

### `references` (inbound)

Keep: `reference`, `typeUse`, `import`, `reExport`, `construct`.

Exclude: `call` (belongs to callers), `implementation` (belongs to implementations / type-callers). Overlap with callers on `construct` for types is intentional (construction is both a use and a “caller” of a type).

### `implementations` (inbound + IR pass)

1. Occurrence pass: keep `implementation` for the target name (type heritage / trait impl heads).
2. **Override pass** (callable-like target with an owner in `qualifiedName` only):
   - `ownerName` = parent segment of `decl.qualifiedName`.
   - Collect type-like decls in scope that contain a child callable with the same bare `name` as the target.
   - Keep child when that type's header range has an `implementation` occurrence of `ownerName` (heritage points at owner), **or** (Rust-shaped) the type file has `implementation` of owner tied to this type — see Rust note below.
   - Emit site `kind: "override"`, line = child decl startLine, preview = child signature line.
3. Type-like targets: occurrence pass only (no override pass).
4. Value-like targets: empty is normal.

### `callees` (outbound — inverted scan)

Not a name scan of the target. Scan **inside the target span** on the defining file only:

| Target kind | Span | Keep kinds | Then |
| --- | --- | --- | --- |
| callable-like | `[bodyStartOffset, bodyEndOffset)` if body present; else empty | `call`, `construct` | resolve each `occurrence.name` to a declaration in scope |
| type-like | `[startOffset, bodyStartOffset ?? endOffset)` (header/heritage/signature only — **not** method bodies) | `implementation`, `typeUse` | names are ancestors/associated types; resolve when possible |
| value-like | body span if any | `call`, `construct` | resolve outward |

Resolution of outbound names:

- Prefer unique bare-name hit in scope via a one-time name index built from scope IR (budgeted scan once per query, reuse for certainty competitors too).
- If `target` file has a file-graph internal edge to a candidate's file, prefer that candidate (exact).
- Multiple remaining → site still listed, `certainty: "ambiguous"`, competitors filled, non-actionable.
- Zero → drop site (unresolved external / builtin — do not invent).

Direct only. No depth param. No recursive callees.

---

## Certainty (syntactic — no type checker)

Built once per query:

1. **Scope name index:** bare `decl.name` → list of `{ path, decl }` from budgeted scope IR scan (cap competitors at identity's bound, 10).
2. **File graph:** `graph.forwardEdges(occurrenceFile)` includes internal edge to `target.path` (inbound tools). For callees, edge from `target.path` to resolved decl path.

Per site:

| Label | When |
| --- | --- |
| `exact` | Same file as defining file, **or** file-graph internal edge binds occurrence file → defining file (inbound) / defining file → callee file (outbound) |
| `inferred` | Not exact, and scope name index has exactly one decl with that bare name |
| `ambiguous` | Not exact, and multiple same-name decls in scope — list bounded competitors; mark non-actionable |

**Go / same-package peers:** package files often share names with **no** import edge. They stay `inferred` when the name is unique, `ambiguous` when not. Do **not** add directory-peer heuristics or a type checker. Honest syntactic certainty.

Format: print certainty only when not `exact` (spec).

---

## Capability / precondition gates

| Condition | Behavior |
| --- | --- |
| `path` not a directory | error |
| target not resolved | candidates or notFound (identity) |
| resolved decl outside scope dir | error |
| target adapter `callEdges === false` (e.g. Markdown heading) | error: relationship edges unavailable for that language |
| scope file adapter `callEdges === false` | skip file |
| empty sites after filters | one-line empty message |
| parseDegraded on any contributing file | footer note once |
| scan/result budgets hit | footer; return partial |

---

## Output

Per spec + `output-density.md`:

- Resolved target once at top: path, name, kind, line.
- Sites grouped by file (path header once).
- Row: line, relationship kind, short **exact** preview (occurrence line trimmed; override = signature line).
- Certainty only when not `exact`.
- Ambiguous → bounded competitors (path, name, line, signature); non-actionable.
- Footers only for omissions / ambiguity collapse / parser trust / budgets.
- Complete-block bounding + temp overflow via shared bounded-text-result handler (tools own wiring; do not copy `DEFAULT_MAX_*`).

### Tool params (all four)

Match spec:

- `path` — directory scope (required)
- `targetPath?`, `name`, `line?` — identity (`targetPath` maps to `Target.path`)
- `resultLimit` — 1…100, required

---

## Per-language `collectOccurrences` tables

Read each grammar's `node-types.json` at the **pinned** rev (`ast/grammars/manifest.json`) before coding. Tables below are the intended classification; adjust field names if the pin differs, do not invent new `OccurrenceKind` values.

**Common algorithm (every adapter):**

1. Walk named nodes (or query name leaves).
2. For each name leaf matching filter (`name` text + offset range):
   - Walk parents/fields to classify.
   - First matching rule wins (tables ordered specific → general).
   - Skip if this leaf is the **definition name** of a declaration node the extractor already owns.
3. Return stable order: source offset ascending.

### TypeScript + TSX (same collector; both registry entries)

| Kind | Name leaves | Classification |
| --- | --- | --- |
| name nodes | `identifier`, `property_identifier`, `type_identifier`, `shorthand_property_identifier` | |
| `call` | those | leaf is `function` field of `call_expression`, or `property`/`name` of `member_expression`/`optional_chain` that is the `function` of `call_expression` |
| `construct` | those | leaf is `constructor` field of `new_expression` (or type name under it) |
| `implementation` | `type_identifier` / nested | under `extends_clause`, `implements_clause`, `extends_type_clause` (class/interface heritage) |
| `import` | those | under `import_specifier`, `namespace_import`, `import_clause` local bindings |
| `reExport` | those | under `export_statement` that has a `source` (re-export path), including `export_specifier` / `namespace_export` |
| `typeUse` | `type_identifier` | `type_annotation`, `type_arguments`, `as_expression`, heritage-adjacent type positions not already `implementation` |
| `reference` | those | everything else that matched the name filter |

TSX: same. Do not special-case JSX tag names as `call` unless the grammar puts them in `call_expression` (usually leave as `reference` / skip non-identifier).

### Go

| Kind | Name leaves | Classification |
| --- | --- | --- |
| name nodes | `identifier`, `field_identifier`, `type_identifier` | |
| `call` | those | callee under `call_expression` `function` (bare ident, or `field` of `selector_expression`) |
| `construct` | `type_identifier` | `type` field of `composite_literal` |
| `implementation` | `type_identifier` | embedded field: `field_declaration` with **no** `name` field (type-only embedding in struct/interface) |
| `import` | identifier in `import_spec` | local alias or package ident when present — only if text equals filter name |
| `reExport` | — | none in Go |
| `typeUse` | `type_identifier` | parameter/result/field types, conversions, asserts — not embedding |
| `reference` | those | else |

### Rust

| Kind | Name leaves | Classification |
| --- | --- | --- |
| name nodes | `identifier`, `type_identifier`, `field_identifier`, `scoped_identifier` / `scoped_type_identifier` (emit **rightmost** name leaf) | |
| `call` | those | `function` of `call_expression`; `macro_invocation` name as `call` |
| `construct` | type leaves | type of `struct_expression` |
| `implementation` | type leaves | trait name in `impl_item` (`impl Trait for Type` → `Trait` is `implementation` when matching Trait); for `impl Type` inherent, `Type` is `typeUse` not implementation of Type |
| `import` | those | names in `use_declaration` paths (imported binding leaf) |
| `reExport` | those | `use_declaration` marked public re-export (`pub use`) |
| `typeUse` | type leaves | other type positions; **type** in `impl Trait for Type` when matching Type |
| `reference` | those | else |

Override pass note: method `foo` on type `Bar` — implementors are types `T` where an `impl Trait for T` or subtype relationship exists. Without a type checker, conservative rule: same-name methods on types that appear as the **type** side of any `impl_item` in scope whose trait side matches an owner trait, OR inherent `impl Owner` methods are the defining side (skip). Practical v1: override pass uses heritage `implementation` occurrences of `ownerName` in other types' headers where the grammar has explicit inheritance; for Rust, also treat `impl ownerName for X` / methods inside `impl ownerName` as same-type, and `impl Trait for X` methods as overrides when target's owner is Trait (owner name match on trait segment). Keep conservative — missed overrides better than wrong ones.

### Java

| Kind | Name leaves | Classification |
| --- | --- | --- |
| name nodes | `identifier`, `type_identifier` | |
| `call` | those | name of `method_invocation`; `explicit_constructor_invocation` |
| `construct` | type leaves | type of `object_creation_expression`, `array_creation_expression` |
| `implementation` | type leaves | `superclass`, `super_interfaces`, `extends_interfaces`, `extends` type lists |
| `import` | those | `import_declaration` single-type import name |
| `reExport` | — | none |
| `typeUse` | type leaves | annotations' type positions excluded or reference; field/param/return types |
| `reference` | those | else |

### Kotlin

| Kind | Name leaves | Classification |
| --- | --- | --- |
| name nodes | `simple_identifier`, `type_identifier` | |
| `call` | those | callee side of `call_expression` (including `navigation_expression` + `call_suffix`) |
| `construct` | type leaves | `constructor_invocation`, creator-ish `call_expression` on types when clearly construction — if ambiguous, `call` is acceptable |
| `implementation` | type leaves | types under `delegation_specifier` / inheritance lists on class headers |
| `import` | those | `import_header` imported name |
| `reExport` | — | none |
| `typeUse` | `user_type` / `type_identifier` | other type positions |
| `reference` | those | else |

### C sharp

| Kind | Name leaves | Classification |
| --- | --- | --- |
| name nodes | `identifier` (and rightmost of `qualified_name` / `generic_name` type args as needed) | |
| `call` | those | name/expression of `invocation_expression` |
| `construct` | those | type of `object_creation_expression`, `array_creation_expression`, `implicit_object_creation_expression` when named |
| `implementation` | those | types in `base_list` |
| `import` | those | `using_directive` name when it matches (type import / alias) |
| `reExport` | — | none typical |
| `typeUse` | those | other type syntax |
| `reference` | those | else |

### Swift

| Kind | Name leaves | Classification |
| --- | --- | --- |
| name nodes | `simple_identifier`, `type_identifier` | |
| `call` | those | `call_expression` / `navigation_expression` + call suffix |
| `construct` | type leaves | `constructor_expression` type |
| `implementation` | type leaves | `inheritance_specifier` / inheritance clause types |
| `import` | those | `import_declaration` path tail when matching |
| `reExport` | — | none unless grammar exposes explicit re-export |
| `typeUse` | type leaves | `type_annotation` and other type positions |
| `reference` | those | else |

### Odin

| Kind | Name leaves | Classification |
| --- | --- | --- |
| name nodes | `identifier`, `field_identifier` | |
| `call` | those | `call_expression`, `selector_call_expression` callee |
| `construct` | those | type position of composite literal if grammar exposes it; else often `typeUse` |
| `implementation` | — | no classic inheritance; leave unused unless a clear embedding form exists in the pin |
| `import` | those | `import_declaration` binding name |
| `reExport` | — | none |
| `typeUse` | those | `named_type` / type slots on decls |
| `reference` | those | else |

Odin proof can be callers/references on a `core/bufio` proc — implementations may honestly return empty.

### Markdown

`callEdges: false`. No collector. Target in Markdown → capability error. File skipped in mixed scopes.

---

## Name index + performance

Per query (not per file):

1. Resolve target.
2. One budgeted `scanSources` of scope to build bare-name → decl[] index (also feeds certainty competitors and callees resolution). Cap list per name at 10.
3. Inbound: second pass or same pass — for each file with `includes(name)`, parse occurrences (step 3 can fuse with step 2: while scanning IR, also run occurrences when prefilter hits). Prefer **one** scope walk that yields IR for the index and occurrence hits for the target name.
4. Apply filters, certainty, `resultLimit` on sites (stable sort: path then line then kind).

Fused walk is preferred (less IO). Shape is implementer choice; behavior above is fixed.

---

## Wiring

- `tools/relationships.ts` exports four `create*Tool` factories **or** one factory × four names — either way four `defineTool` registrations, one shared execute.
- `index.ts` registers all four with existing `rowState` / `temporaryOutput` / `engineFor` / `graphFor`.
- Task 10 imports `queryRelationships` from `graph/relationships.ts` only.

Fallow: new files reachable from `index.ts` before task ends (no permanent ignore).

---

## Non-goals (do not “improve” into these)

- No type checker, no LSP, no rustc/go/tsc.
- No directory-peer or same-package certainty hack.
- No cross-language occurrence tables in shared code.
- No occurrence kind beyond the seven listed (+ site-only `override`).
- No `tests` tool.
- No depth on callees/callers.
- No caching Trees.
- No new unit tests.

---

## Done when

After `/reload`, real harness tools per [`../LIVE-PROVE.md`](../LIVE-PROVE.md):

### TypeScript (`pi` and/or `excalidraw`) — full case set

- Direct function call → `callers`
- Method call (`obj.foo()`) → `callers` on method
- `new Foo()` → `callers` / `references` on type
- Type annotation / `typeUse` → `references`
- `export { X } from` → `references` with `reExport`
- Ambiguous duplicate bare name → candidates or ambiguous sites with competitors
- `callees` from a function body → resolved outbound calls
- `implements` / `extends` → `implementations` and type `callers`

### Every other programming corpus language — at least one real hit each

Not capability errors. Prefer `callers` or `references` on a concrete symbol:

| Language | Corpus scope (suggested) |
| --- | --- |
| Go | `go-tui` |
| Rust | `ast-bro/src` |
| Java | `guava/.../base` |
| Kotlin | `okio/.../okio` |
| C# | `Avalonia/.../Avalonia.Base` |
| Swift | `swift-collections/.../DequeModule` |
| Odin | `Odin/core/bufio` |

Adapter owns node maps. Empty `implementations` on Odin is fine if callers/references work.

### Also

- Empty result one-liner; budget/limit footers sane.
- Markdown target errors cleanly; Markdown files in a mixed scope do not break the walk.
- `check:ts` green.
- Task 10 can import `queryRelationships` without touching tools.
