# AST explore architecture rewrite

Critique of the current explore/AST system architecture, the patterns it accidentally inverted, and the simpler extensible shape that keeps the same product goals.

## Status

Historical critique. Several product decisions here are **superseded** by [`explore-specs/`](explore-specs/README.md) and [`explore-wasm-rewrite/`](explore-wasm-rewrite/README.md): no locators, no orientation gate, no Explore write tools, no Explore `ls`/`find`/`grep`/`read`, WASM in-process engine instead of native worker. Keep for autopsy of anti-patterns; do not implement this document’s old product surface.

## Product goals to keep

1. Structural orientation without dumping whole files
2. Stable locators to pull exact code later
3. Search / refs / callers that return actionable sites
4. Locator-safe edits
5. Bounded model-visible text
6. Multi-language support
7. Read gate / orientation so models stop raw-reading supported source as first move

---

## The real indictment

File size is a symptom. The architecture bug is deeper:

**There is no system.** There are procedures that happen to share a closure and a subprocess.

Every tool re-implements the same life cycle by hand:

1. resolve path
2. talk to worker
3. mutate locator table while printing
4. record orientation
5. shove strings into a bounded builder
6. maybe print an exception footer
7. pack a details bag for the TUI

That is not modular code with too few files. That is **no domain model, no pipeline, no session capability layer, and no stable view layer**. Splitting `ast-tools.ts` into ten files without fixing that just creates ten smaller places to paste the same ceremony.

Native side has the same disease at larger scale:

- language extractors exist (`typescript.rs`, `go.rs`, …)
- but `OutlineEngine` is still the god object: outline, recursive walk, symbol, and then `impl OutlineEngine` blocks in `discovery.rs`, `search.rs`, `relationships.rs`, `edits.rs`
- `outline.rs` alone is a ~5k-line airport terminal
- relationships re-walk and re-parse instead of querying a session index
- TypeScript import-alias fanfic lives inside relationship collection

So the hire did not "forget to split files." The hire built **operation scripts** on both sides of the FFI wall and called it an architecture.

---

## What complexity is real vs invented

### Real

- multi-language syntax and visibility rules
- stale identity after mutation
- honest ambiguity for refs/renames
- parser recovery
- model-visible output budgets separate from traversal budgets
- not letting read bypass structural orientation

### Invented

- two language stacks (native extract + TS display archaeology)
- formatting that allocates session identity
- every tool owns its own orchestration
- every operation re-discovers the repo
- protocol types trusted by `as unknown as`
- summary/footer policy hand-copied per tool
- `containerFrame` reverse-engineering braces from signature strings the worker already derived from ranges
- five relationship tools that are one tool with a string enum, still closed over the universe
- orientation, locators, overflow, mutation verify, and pretty-printing braided into one factory

Invented complexity multiplies. Real complexity adds. This codebase multiplies.

---

## Architectural anti-patterns currently on display

### 1. God object / god factory

`createAstTools(...)` is a service locator, registry, renderer, edit coordinator, and tool module factory.

`OutlineEngine` is the Rust twin: one type grows a method every time someone needs a verb.

### 2. Snapshot scripts instead of an index

Each tool call is a batch job:

- walk tree
- parse files
- compute answer
- throw most of the parse work away
- next tool starts over

That makes latency and code both worse. Extending the system means writing another batch job with another copy of walk/parse/budget/error accounting.

### 3. View layer mutates the document

Locator IDs are session identity. They get minted inside `renderEntry` while building display text.

Once presentation assigns identity, you cannot:

- reformat without ID churn risk
- overflow-trim without ID garbage collection logic glued to builders
- test formatters as pure functions
- share locator binding with non-text consumers

This is classic **view/model contamination**.

### 4. Dual rendering / no single IR

Native already builds structured outline items. TS does not treat that as the display model. It treats `signature: string` as a puzzle to re-parse:

- docs lines before locator
- annotation depth
- brace frames
- enum separators
- tuple suffixes
- markdown heading line picking

So language work is paid twice: once to extract, again to pretty-print by folklore.

### 5. Copy-paste polymorphism

`api_discover`, `ast_search`, relationship tools, recursive outline finish paths: same algorithm, different nouns. No shared pipeline type. Drift is inevitable. Payload cleanup proved it.

### 6. Stringly typed extension surface

Agent-facing success path is mostly unstructured text. Structured `details` exist for TUI collapse counts, but the model-visible contract is a blob. So:

- tests snapshot blobs
- policy changes rewrite blobs
- no second consumer (GUI, RPC, subagent memory) can reuse results without scraping

Text is a **projection**, not the domain.

### 7. Boundary cosplay

`AstClient` looks like a port. Then:

```ts
return result as unknown as OutlineTargetResult;
```

A port that cannot validate its DTOs is a wish. The worker protocol version is a number you bump when scared, not a codec with explicit upcasters and fail-loud decoders.

### 8. Policy sprayed as inline conditionals

Exception footers, orientation attempt mapping, overflow strategy, read-gate decisions, human-vs-agent text: all policy. Policy is currently `if` soup inside execute bodies instead of named policy objects/functions with tests.

### 9. Extension-local reinvention of tool runtime

Across Tau extensions, every tool hand-rolls:

- `createToolRowStateStore`
- `defineTool`
- call-row component
- collapse/expand render
- path resolve
- sometimes bounded text
- sometimes events

Explore is the worst because it has the most tools, but the missing layer is agent-wide: **tool runtime / session capabilities**, not "a couple helpers in `shared/`."

`BoundedTextResultBuilder` is one real shared primitive. Everything above it is still artisanal.

---

## Patterns this system should follow

Not fashion. These map to actual pain.

### A. Session capability architecture (ports + composition root)

A coding session owns capabilities, tools do not own infrastructure.

```text
ExploreSession / AgentSession
  paths: PathService
  fsWalk: TraversalService
  ast: StructuralIndex          // port; native worker implements
  locators: LocatorTable
  orientation: OrientationGate
  output: BoundedOutput
  mutations: MutationBus
  readCache: ReadCache
```

Composition root (`explore/index.ts` or a future agent host) wires implementations once.

Tools become:

```ts
execute(args, ctx) {
  return ctx.capabilities.ast.outline(...)
    .then(bindLocators)
    .then(format)
    .then(bound)
}
```

Or thinner: tools are command handlers over the session.

**Why this shrinks code:** walk budgets, worker lifecycle, invalidation, temp output, row state stop being reconstructed per tool factory.

**Agent-wide:** web/patch/subagent/explore all need row state, events, sometimes bounded output, sometimes cwd path rules. That is shared session machinery, not each extension inventing a backpack.

### B. Pipeline / stages (explicit data flow)

One discovery pipeline, configured per operation:

```text
Input
  -> ResolveScope
  -> QueryIndex | RunWorkerOp
  -> DomainResult
  -> LocatorBinding
  -> ViewModel
  -> TextProjection
  -> BoundedEmission
  -> ToolResult
```

Rules:

- each stage is a pure or narrowly effectful function
- stage inputs/outputs are typed
- no stage reaches back into the locator map "a little"
- overflow trimming happens at `BoundedEmission`, with locator retention policy applied there only

Recursive outline is the streaming variant of the same pipeline (`for await unit`).

This is ordinary **pipes and filters**. It destroys the copy-paste tool bodies.

### C. Model / view / projection

Three layers, not two:

1. **Canonical structural model** (language-neutral as much as possible)
   - declarations, ranges, members, docs spans, body ranges, visibility, certainty, fingerprints
2. **View model / display IR**
   - sections, rows, indents, open/close tokens, pre/main/post lines, locator tokens (native tokens, not session IDs)
3. **Projection**
   - text for model
   - optional TUI model
   - later: JSON for subagents, etc.

Session locator IDs bind in a dedicated `LocatorBinding` stage:

```text
display IR (native tokens) + LocatorTable -> display IR (session ids) -> string
```

Formatters never call `registerLocator`.

### D. Language as plugin, not switchyard

Native already almost has this with `extract_*` / `filter_*` / `finalize_*` / `matching_*_imports`. Make it a real trait/object:

```rust
trait LanguageAdapter {
    fn id(&self) -> LanguageId;
    fn extract(&self, source, opts) -> Vec<Item>;
    fn filter(&self, items, opts);
    fn finalize(&self, items);
    fn imports_for(&self, source, decl) -> Vec<&str>;
    fn resolve_name(&self, ...) -> ...; // only if needed
}
```

Dispatcher becomes registry lookup. Adding Kotlin edge cases touches Kotlin. `outline.rs` stops being the municipal dump.

TS side either:

- **preferred:** trusts display IR produced once from canonical model (possibly native-side projection hooks for true syntax trivia), or
- has `languages/typescript.ts` projecting canonical model → display IR

What dies: TS `containerFrame` and ten-way `language ===` chains.

### E. Structural index, not per-call batch jobs

Biggest behavioral architecture change:

```text
StructuralIndex
  generation
  parse cache by (path, fingerprint)
  declaration index by name / qualified name
  export graph (at least TS/ES)
  invalidate(paths) | clear()
```

Operations become queries:

| Tool | Query |
| --- | --- |
| outline | project file/dir from index |
| api_discover | filter declarations + surface rules |
| ast_search | pattern over indexed or scanned files |
| references/callers/... | occurrence query + resolve |
| plan_edit | load targets + impact query |

Worker can still be the process boundary. Internally it should look like a small query engine with a cache, not a collection of unrelated CLIs glued by JSON.

**Why this simplifies code:** one walk implementation, one parse entrypoint, one budget accountant, one degraded-parse recorder. Operations stop re-expressing repository physics.

### F. Command pattern for edits

Edits already want this. Make it explicit:

```text
EditCommand -> Plan -> Apply -> Verify -> Invalidate -> FreshBind
```

`replace_declaration` / `replace_body` / `insert` / `rename` are command codecs into one executor. Tool files only expose schema + name.

Verification policy is swappable. Mutation bus publish is one step. Locator invalidation is table policy, not a for-loop buried in execute.

### G. Policy objects

Named, tested, tiny:

- `ExceptionPolicy` — only emit bad news / limits
- `OrientationRecorder` — map domain results to gate attempts
- `OverflowPolicy` — head / tail / completeBlocks + locator retention
- `ReadGatePolicy` — already partly exists in settings + orientation
- `CertaintyPolicy` — when relationships are actionable

When product says "stop printing happy summaries," you change one policy. You do not grep six tools.

### H. Codec boundary (anti-corruption layer)

Worker DTOs are foreign. Decode them:

- schema validation (zod/valibot/hand guards)
- map to internal model
- reject unknown shapes with field paths
- version bump includes decoder migration or hard fail

No `as unknown as` on the success path.

Shared pattern for any native/helper process Tau grows later.

### I. CQRS-lite for agent tools

Commands change world: edits, patch, maybe subagent spawn.

Queries read world: outline, grep, search, refs, ls.

Shared:

- query path never mutates files
- command path always goes through plan/apply/invalidate
- both share index/locator/orientation capabilities

Today edits are bolted beside queries inside the same factory with shared mutable soup. That is why invalidation logic feels haunted.

### J. Hexagonal / ports where it actually pays

Worth a port:

- `StructuralIndex` / `AstEngine`
- `BoundedOutputStore`
- `MutationBus`
- `Clock` / budget time source if tests need it

Not worth ceremony:

- path join
- "repository" interfaces over one function
- abstract factory factories

Use ports at process and session edges. Inside the domain, plain functions on data.

---

## Target runtime shape

```text
packages/agent/
  shared/
    session/                 # optional long-term: row state, temp output, events glue
    tool-runtime/            # defineTool helpers, call-row, bounded emit, path ctx
    bounded-text-result.ts   # already exists
    ...

  extensions/explore/
    index.ts                 # composition root only
    session.ts               # builds ExploreCapabilities
    capabilities/
      orientation.ts
      locators.ts
      paths.ts
    ast/
      port.ts                # StructuralIndex interface
      worker-codec.ts        # frame protocol + decode
      worker-index.ts        # AstWorker-backed implementation
      pipeline.ts            # shared query/command pipelines
      format/                # pure projections
      languages/             # only if TS-side projection still needed
      commands/edit.ts
      queries/
        outline.ts
        symbol.ts
        search.ts
        discover.ts
        relationships.ts
    tools/                   # thin schemas + wiring
      outline.ts
      ...
    read/
    grep/
    fs/                      # ls/find/traverse
```

Native:

```text
tau-ast/
  protocol/           # frames, version, DTOs
  index/              # parse cache, declaration index, invalidation
  language/           # LanguageAdapter trait + impls
  query/
    outline.rs
    symbol.rs
    search.rs
    discover.rs
    relationships/
      occurrences.rs
      resolve.rs
      classify.rs
      scope.rs
  command/
    edit.rs
  main.rs             # dispatch only
```

`OutlineEngine` as god object dies. Engine becomes index + registry + query services.

---

## Shared functionality across the rest of the agent

Explore pain is extreme, but the missing shared architecture is wider.

### Today

Each extension:

- makes its own row-state store key
- writes its own `renderCall` title line
- sometimes knows about temp output
- sometimes emits Tau events
- duplicates path/`@` handling if it touches files

`shared/` has useful atoms (`bounded-text-result`, `temporary-output-store`, `tool-row-state`, events, settings) and almost no **molecule**: no standard tool execution envelope.

### Target shared molecules

1. **`ToolRuntime`**
   - row state binding
   - standard call-row
   - standard collapsed result ("N items, size, expand hint")
   - error normalization
   - optional bounded emission wrapper

2. **`SessionResources`**
   - cwd
   - temp output lifecycle tied to session_start/shutdown
   - event bus helpers
   - generation counter for stale handles

3. **`BoundedQuery` helper**
   - unit stream in
   - text projection in
   - overflow + optional retain/drop callbacks out
   - used by explore AST, maybe web fetch long bodies, context tools, etc.

4. **`FileMutation` pipeline**
   - patch + locator edit both publish the same event
   - listeners (orientation, locators, read cache) subscribe once in composition roots

This is how line count drops outside explore too: stop paying a tool tax of 80 lines of harness per verb.

---

## Concrete simplifications that cut lines for real

Not "clean code" vibes. Mechanisms:

1. **One pipeline for all multi-unit AST tools**  
   Deletes most of `api_discover` / `ast_search` / relationship execute bodies.

2. **Locator bind stage**  
   Deletes side effects from every formatter; tests become pure.

3. **Display IR**  
   Deletes `containerFrame`, annotation scanners, and language boolean chains.

4. **Language adapter trait + registry**  
   Deletes dispatcher duplication in native outline/symbol/import matching.

5. **Structural index with parse cache**  
   Deletes repeated walk/parse/budget code paths across discovery/search/relationships/edits; shrinks Rust and latency.

6. **Single relationship query with operation filter**  
   Deletes five tool implementations down to one factory and one native entrypoint (already almost true, finish the job).

7. **Exception policy module**  
   Deletes footer reconstruction branches.

8. **Codec decoders**  
   Deletes "formatter crashed on undefined" class of bugs and defensive junk.

9. **Thin tools**  
   Tool files become schema + one call. Registration in `index.ts` becomes a loop over a catalog.

10. **Shared tool runtime**  
    Deletes repeated TUI/row-state boilerplate across extensions.

Multiplicative cost today:

```text
cost ~= operations × languages × pipeline_stages_inlined
```

Target:

```text
cost ~= operations + languages + pipeline_stages
```

That is the whole game.

---

## What "extensible" means here

Adding a language should mean:

1. implement `LanguageAdapter` (extract/filter/finalize/imports)
2. register in language registry
3. add fixtures for extract + one projection snapshot

It should not mean:

- touch TS renderer switchyards
- touch relationship identifier heuristics with more `match` arms unless language truly needs a resolve plugin
- touch every tool test blob

Adding a tool should mean:

1. define args schema
2. pick query or command pipeline
3. provide projection
4. register in catalog

It should not mean opening the cathedral to paste a new execute closure.

Adding an output consumer (TUI detail pane, subagent structured memory) should mean:

1. new projection from view model

It should not mean scraping model text.

---

## Migration approach without a death march

Order matters. Do not "clean while inventing."

1. **Introduce display IR + pure formatters behind existing tools**  
   Same bytes out. Locator bind extracted. No product change.

2. **Introduce shared AST query pipeline**  
   Migrate `api_discover` / `ast_search` / relationships onto it. Delete duplicate execute code.

3. **Codec validation at worker boundary**  
   Fail loud. Keep types honest.

4. **Native language trait + registry**  
   Move extractors behind trait without changing JSON.

5. **Parse cache / structural index inside worker**  
   Invalidation on generation and file change. Operations become queries.

6. **Edit command executor unification**  
   Thin four edit tools.

7. **Shared tool-runtime molecules**  
   Start using from explore, then other extensions opportunistically.

8. **Only then** delete dead string archaeology and collapse files that are now actually empty of policy.

Each step stays green. Output snapshots may stay temporarily while pure fixtures grow beside them; then snapshot surface shrinks to integration smoke only.

---

## Delete-on-sight list (architecture edition)

- `createAstTools` as the brain of the system
- `OutlineEngine` as the dumpster for every verb
- formatter-owned locator registration
- `containerFrame` and signature re-parsing in TS
- per-tool orchestration clones
- `as unknown as` DTO success paths
- happy-path summary footers rebuilt inline
- relationships re-walk with ad hoc TS module resolution embedded mid-file
- five relationship tools with five copies of lifecycle
- extension-local reimplementation of tool harness concerns already solved next door

---

## Non-goals

- rewriting tree-sitter / ast-grep choices for fashion
- microservices
- generic DI container frameworks
- abstracting every function behind an interface
- changing user-facing tool names/behavior in the architecture pass unless product asks
- backward compatibility shims for internal modules

---

## Bottom line

Current system is a pile of **batch scripts** sharing a subprocess and a closure, with a second display compiler in TypeScript that does not trust the first compiler in Rust.

Good architecture for this product is:

1. **session capabilities** instead of tool-owned infrastructure
2. **structural index** instead of per-call repository archaeology
3. **pipeline stages** instead of copy-paste execute novels
4. **canonical model → display IR → projection** instead of string surgery
5. **language plugins** instead of switchyards
6. **policy objects** instead of inline product rules
7. **codecs at the boundary** instead of type assertions
8. **shared tool runtime** so explore is not the only adult in the agent

Same goals. Additive complexity for languages and operations, not multiplicative. Extending becomes registration, not excavation.

File splits without that spine are interior decorating in a condemned building.
