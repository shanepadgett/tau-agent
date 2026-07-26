# System

## Purpose

- Give agents structural source orientation, exact source slices, graph queries, and budgeted context packs.
- Prefer compact model payloads over dumping whole files when structure answers the question.
- For large supported source, full harness `read` returns outline instead of body (Explore overlay); bodies come from ranged `read` or `show`.
- Keep scans bounded, deterministic, ignore-aware where applicable, and cancellable.
- File mutation is not an Explore responsibility; agents use harness `patch` / `edit` / `write`.
- Filesystem list/search/read tools are **not** an Explore responsibility; agents use harness/Pi `ls` / `find` / `grep` / `read`.
- **Language growth is a first-class product goal:** adding a language must not require new tools, new identity rules, new read policy, or per-language agent workflows.

## Language model

### Contract

- Structural behavior is defined against a **shared declaration/graph IR** and a **registered language adapter** set, not against a frozen world list baked into each tool spec.
- Tool contracts (`outline`, `show`, `discover`, graph tools, `impact`, `context`, `ast_search`) and structural `read` overlay are language-agnostic. They operate on whatever languages the engine currently registers.
- A language is “supported” only when registered with the engine for the needed capability (shape, search, file edges, call edges, package surface — adapters may implement a subset).
- Unsupported path/language → clear error naming that the language/capability is unavailable. No silent pretend parse.
- Capability gaps are honest: if a language has outline/`show` but not call graph, `callers`/`impact` say so; they do not fake edges.

### Adding a language (acceptance bar)

Shipping a new language means registering an adapter that maps that language onto the existing IR and capabilities. It must **not** require:

- new Explore tool names or tool split
- session locators or new identity scheme
- changes to read threshold/range policy
- changes to `impact` / `context` section meanings
- per-language branches in agent-facing guidance beyond listing newly backed languages

It may add:

- extension ↔ language mapping
- adapter parse/outline/show
- optional file-dep extraction, call-edge extraction, package-surface resolution, ast-search grammar wiring
- declaration kind mappings into the shared kind vocabulary (extend vocabulary only when a real new kind exists)

### Baseline registered set (current product)

Engine ships at least these when the build includes them:

- TypeScript (`.ts`)
- TSX (`.tsx`)
- Odin (`.odin`)
- Go (`.go`)
- Rust (`.rs`)
- C# (`.cs`)
- Java (`.java`)
- Kotlin (`.kt`, `.ktm`, `.kts`)
- Swift (`.swift`)
- Markdown (`.md`, `.markdown`, `.mdown`)

This list is the **current baseline**, not the ceiling. Tool specs refer to “registered supported languages” / “engine-advertised languages,” not a duplicated closed enum per tool.

### Markdown

- Markdown stays structurally outline/`show`-able and **ungated** for full `read` ([read-policy.md](read-policy.md)).

## Platform / engine availability

- In-process structural engine (WASM tree-sitter + adapters) is required for: `outline`, `show`, `discover`, `ast_search`, file graph, symbol graph, `impact`, `context`, and the large-`read` outline overlay.
- Engine advertises the registered language set and per-language capabilities to the session.
- Structural tools run on any host where the Node/WASM runtime loads (no darwin-arm64-only native worker).
- If the engine fails to init, structural tools fail with a clear install/runtime error when invoked; harness fs tools still work.
- Structural tools remain registered even when the engine is unavailable (fail on use).

## Session lifecycle

- Session start: reset tool-row state, graph/parse cache, temporary output store; reload Explore settings.
- Session tree change: reset graph/parse cache as required for branch safety.
- Session compact: no Explore complete-file baseline to clear (none exists). Graph/parse cache policy as implemented for branch safety.
- Session shutdown: clear graph/parse cache; shut down engine WASM objects; shut down temporary output store.
- Successful Tau file mutations invalidate graph/parse cache for changed paths.

## Shared cache (product requirement)

- One session-scoped parse + file-graph + call-graph cache backs [outline.md](../shape/outline.md), [show.md](../shape/show.md), [deps.md](../graph/deps.md), [reverse-deps.md](../graph/reverse-deps.md), [relationships.md](../graph/relationships.md), [impact.md](../graph/impact.md), and [context.md](../graph/context.md).
- Cache entries for a path are dropped or rebuilt when that path is mutated through the harness mutation bus.
- Agents must not need a manual rebuild flag for ordinary edit→query sequences in the same session.

## Cross-cutting contracts

- Target identity: [identity.md](identity.md)
- Structural full/ranged read overlay: [read-policy.md](read-policy.md)
- Agent text density: [output-density.md](output-density.md)
- Model-visible caps / temp overflow: [bounded-output.md](bounded-output.md)
- Paths / ignore / traversal budgets: [path-conventions.md](path-conventions.md)
- Settings: [settings.md](settings.md)
- Non-carry-forward delete list: [stripped.md](../stripped.md)

## Agent workflow expectations (product intent)

- Identify the job first: locate, reuse, edit, explain, or debug.
- Use the cheapest useful step before loading bodies or graph fan-out needed only later.
- Stop when the current question is answered; expand only for a specific unresolved question.
- Before a non-trivial change to a symbol, run `impact` on that symbol.
- To understand a symbol in one shot, run `context`.
- Edit with harness patch/edit/write. No Explore write tools.
- List/search files with harness `ls` / `find` / `grep`. Read with harness `read` (large supported full reads become outline).
- Same structural workflow for every registered language. No language-specific tool choreography.

## Commands

- None. Explore exposes tools, the read overlay, and pre-turn guidance only.
- `/read-stats` and all read-stats machinery are stripped ([stripped.md](../stripped.md)).
