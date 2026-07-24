# Tau AST Exploration Baseline

Status: research baseline; no implementation approved yet  
Captured: 24 July 2026

## Purpose

Tau should have first-party, AST-based code exploration tools. They should be real Pi tools with strict schemas, bounded outputs, custom rendering, lifecycle control, and enforceable interaction with Tau's existing `read` tool. Users should not have to install a separate CLI, edit an agent prompt, or trust a model to remember when structural exploration is appropriate.

This document preserves the current research and architectural baseline. It covers four reference repositories, Tau and Pi integration points, the current Tree-sitter and native-packaging landscape, a recommended initial architecture, known risks, and unresolved decisions.

The reference repositories are read-only examples:

- `ast-bro`: `/Users/shanepadgett/.local/share/tau-agent/references/ast-bro`
- `ast-grep`: `/Users/shanepadgett/.local/share/tau-agent/references/ast-grep`
- `ast-outline`: `/Users/shanepadgett/.local/share/tau-agent/references/ast-outline`
- `errata`: `/Users/shanepadgett/.local/share/tau-agent/references/errata`

## Goals

- Make structural code exploration a built-in Tau capability.
- Reduce source text sent to models during discovery.
- Give agents precise tools instead of relying only on prompt guidance.
- Support Odin as a first-class language rather than treating it as an unsupported edge case.
- Keep interactive latency close to native AST tools.
- Allow language and capability support to expand without changing the agent-facing foundation each time.
- Preserve exact source locations so agents can move from summaries to targeted implementation reads.
- Integrate with Tau's read cache, patch events, tool rendering, cancellation, and session lifecycle.
- Distribute everything with Tau. No separately installed executable or service.

## Non-goals for the first release

- A language server replacement.
- Type checking or compiler-grade semantic resolution.
- A complete call graph.
- Embedding-based semantic search.
- A persistent repository index.
- AST-driven source rewriting.
- Runtime loading of arbitrary third-party grammars.
- Perfect prevention of filesystem reads through an unrestricted shell.

These may become useful later. Building them before the basic tool contract and parser behavior are proven would hide correctness problems beneath cache and inference machinery.

## Main conclusion

Build a Tau-owned Rust AST engine around Tree-sitter and selected `ast-grep` library crates. Expose it through a long-lived, package-private worker process controlled by Tau's TypeScript extension. The worker should speak a versioned framed protocol over stdin and stdout and should have no supported user-facing CLI.

The product-specific work belongs to Tau:

- the language-independent declaration model
- the grammar registry
- language adapters
- compact model output
- stable source locators
- cache and invalidation behavior
- Pi tool contracts
- tool rendering
- read-routing policy
- context budgets and truncation
- native artifact selection and lifecycle

Tree-sitter already provides parsing. `ast-grep-core` already provides a strong structural matching foundation. Reimplementing either would add years of parser and matcher edge cases without making Tau more specific to agent workflows.

The proposed boundary is:

```text
Tau explore extension
  ├── outline
  ├── symbol
  ├── ast_search
  └── AST-aware read policy
          │
          │ versioned framed JSON over stdin/stdout
          ▼
long-lived tau-ast Rust worker
  ├── grammar registry
  ├── language adapters
  ├── parser pool
  ├── source/tree/declaration cache
  ├── ast-grep structural matching
  └── parallel repository walker
```

The internal worker is an executable artifact, but it is not a separately deployed tool in the sense the references use CLIs. Tau selects it, starts it, cancels requests, restarts it after failure, and closes it during session shutdown. The user interacts only with Pi tools.

## Reference repository findings

### `ast-bro`

#### Architecture

`ast-bro` is a Rust 2021 native application. It builds the primary `ast-bro` binary plus `ast-outline` and `sb` binaries. Major dependencies include `ast-grep`, Tree-sitter, `ignore`, `rayon`, Serde, graph libraries, search libraries, and cache libraries.

Its major subsystems share a declaration representation and common file filtering:

- repository shape rendering
- digest and public surface extraction
- dependency graph
- call graph
- impact analysis
- context packing
- structural search and rewriting
- semantic search
- text squeezing

The normal shape pipeline is:

```text
ignore::WalkBuilder
  → language detection
  → Tree-sitter/ast-grep parse
  → language adapter traversal
  → canonical Declaration tree
  → text or JSON renderer
```

Relevant sources:

- `ast-bro/Cargo.toml`
- `ast-bro/wiki/architecture.md`
- `ast-bro/src/lib.rs`
- `ast-bro/src/file_filter.rs`
- `ast-bro/src/adapters/base.rs`

#### Language model

Adapters implement a generic `LanguageAdapter` trait over `ast_grep_core::Node`. They map grammar-specific node kinds and fields to declarations. Shape, call, and dependency adapters explicitly cover Rust, Python, TypeScript/JavaScript, C#, Go, Java, Kotlin, Scala, C++, Ruby, and PHP.

Markdown uses `tree-sitter-md` directly. SQL uses regular expressions because SQL is absent from the ast-grep built-in language set used by this checkout. Search chunking supports a broader language set than declaration outlining because it only needs useful top-level AST boundaries.

This distinction matters for Tau: parsing support, structural search support, and high-quality declaration extraction are separate levels of language support. A grammar alone does not produce a useful outline.

Relevant sources:

- `ast-bro/src/main_helpers.rs`
- `ast-bro/src/adapters/markdown.rs`
- `ast-bro/src/adapters/sql.rs`
- `ast-bro/src/search/chunker.rs`

#### Cache design

Dependency and call graphs share `.ast-bro/deps/graph.bin`, storing one `UnifiedGraph`. A process-wide `OnceLock<RwLock<HashMap<root, Entry>>>` retains `Arc<UnifiedGraph>` instances and file fingerprints. MCP calls can reuse and patch graph state instead of rebuilding unchanged files.

Semantic search uses a separate `.ast-bro/index/` with metadata, chunks, embeddings, BM25 data, file records, and a write lock. Freshness checking uses modification time and size first, then xxhash3 when metadata changes. Modified files are tombstoned, re-chunked, re-embedded, and appended. Full rebuild and compaction are fallback paths.

Writes use advisory `fs2` locks and temporary files followed by atomic rename.

Relevant sources:

- `ast-bro/src/graph_cache/shared.rs`
- `ast-bro/src/graph_cache/cache.rs`
- `ast-bro/src/search/cache.rs`
- `ast-bro/wiki/search.md`
- `ast-bro/wiki/calls.md`

The useful lesson is process-resident reuse. The warning is cache complexity. `ast-bro` documents a real binary serialization corruption problem caused by skipped bincode fields. Tau should avoid a persistent binary cache until the schema and invalidation semantics are stable.

#### Capabilities

The project exposes a broad set of operations:

- `map`
- `digest`
- `show`
- `implements`
- `surface`
- `deps`
- `reverse-deps`
- `cycles`
- `graph`
- `callers`
- `callees`
- `trace`
- `impact`
- `context`
- `search`
- `find-related`
- `index`
- `run`
- `squeeze`

`run` uses ast-grep patterns and metavariables for structural search and optional rewrite. Writes require an explicit flag.

Call resolution is approximate. It checks same-file bindings, a global symbol table, and dependency closure, then records edges as exact, inferred, or ambiguous. Dynamic dispatch, receiver inference, and homonyms remain hard. Tau must represent uncertainty if it later adds graph capabilities.

Relevant sources:

- `ast-bro/README.md`
- `ast-bro/src/run/mod.rs`
- `ast-bro/wiki/calls.md`

#### Context-saving behavior

Text is the default agent-facing output. JSON is opt-in and versioned per operation. `map` emits declaration names, signatures, documentation, line ranges, and optional attributes while omitting bodies. Headers report file scale and parse warnings.

The `context` command enforces a hard estimated token budget. It prioritizes the target body, direct callees, callers, and then transitive context. Type targets can include implementors and methods. It reports truncation and omitted target bodies explicitly. Its token estimate is approximately `bytes / 4`.

This is a useful later-stage model for Tau. The first version should establish reliable outlines, locators, and exact symbol reads before trying to rank inferred context.

Relevant sources:

- `ast-bro/src/core.rs`
- `ast-bro/wiki/context.md`
- `ast-bro/wiki/squeeze.md`

#### Performance

- `ignore` performs gitignore-aware traversal.
- `rayon` parallelizes filesystem and per-file work.
- A static 256-dimensional model2vec table is memory-mapped for semantic search.
- Cosine search is SIMD-vectorized and parallelized for large indexes.
- BM25 and dense results are merged with reciprocal-rank fusion.
- Search ranking includes definition boosts, file coherence, generated/test penalties, and file saturation decay.
- Downloaded models are SHA-256 verified and atomically installed.

Most of the semantic-search machinery is outside Tau's initial need. Parallel walking, bounded work, and process-resident state are directly reusable.

#### Deployment

The MCP server is synchronous line-delimited JSON-RPC over stdin/stdout. It avoids a Tokio runtime, dispatches into existing renderers, and catches panics as protocol errors.

The npm and Python packages are wrappers that download and cache the Rust executable. In this checkout they advertise only macOS arm64 prebuilt artifacts, falling back to Cargo installation otherwise. The release Makefile packages macOS arm64 binaries.

Tau should copy the process ownership idea and avoid the limited release coverage and external CLI identity.

Relevant sources:

- `ast-bro/src/mcp/mod.rs`
- `ast-bro/cli-typescript/bin/install.js`
- `ast-bro/cli-python/ast_bro_cli/__init__.py`
- `ast-bro/Makefile`

#### Main lessons

- A shared declaration model can support many agent-oriented operations.
- A resident process provides meaningful warm-call reuse.
- Compact text and versioned structured data serve different consumers.
- Context packing needs hard budgets and explicit truncation.
- Graph inference must expose ambiguity.
- Grammar node names drift and need fixtures.
- Persistent cache schemas create real correctness risk.
- The complete `ast-bro` feature set is too much for Tau's first slice.

### `ast-grep`

#### Architecture

The local checkout is a Rust 2024 workspace with Rust 1.88 as its minimum version and Tree-sitter 0.26.3 as its parsing foundation.

Major layers are:

- `ast-grep-core`: generic languages, documents, AST traversal, matching, and replacement
- `ast-grep-language`: built-in languages and grammar bindings
- `ast-grep-config`: YAML rules and configured scanning
- CLI
- LSP
- N-API
- Python
- WebAssembly

The CLI exposes `run`, `scan`, `test`, `lsp`, `outline`, and completion commands. Tau does not need to wrap that CLI to reuse the underlying implementation.

Relevant sources:

- `ast-grep/Cargo.toml`
- `ast-grep/crates/core/Cargo.toml`
- `ast-grep/crates/core/src/language.rs`
- `ast-grep/crates/cli/src/lib.rs`

#### Grammar handling

Built-in grammars are statically linked through optional Cargo dependencies and a `builtin-parser` feature. Each language supplies a Tree-sitter language, node-kind and field lookup, and pattern construction.

Custom grammars can be loaded from shared libraries. The loader resolves `tree_sitter_<name>` by default, keeps the library alive for the language symbol's lifetime, and validates Tree-sitter ABI compatibility. Extensions and custom globs map files to languages.

Dynamic loading is useful evidence that Odin can fit the ast-grep abstraction. Tau should still statically compile the initial grammar set. Runtime shared-library loading introduces unsafe lifetime requirements, ABI packaging, and user configuration before Tau needs them.

Relevant sources:

- `ast-grep/crates/language/Cargo.toml`
- `ast-grep/crates/language/src/lib.rs`
- `ast-grep/crates/dynamic/src/lib.rs`
- `ast-grep/crates/dynamic/src/custom_lang.rs`
- `ast-grep/crates/cli/src/lang/lang_globs.rs`

#### Matching model

Patterns are parsed as code and support `$VAR`, `$$VAR`, and `$$$VAR` metavariables. Contextual patterns can select a specific node kind.

Configured rules include:

- pattern
- kind
- regular expression
- range
- nth-child
- `inside`
- `has`
- `precedes`
- `follows`
- `all`
- `any`
- `not`
- utility-rule calls

Matching has strictness levels from concrete syntax through AST, relaxed/signature matching, and template matching. Replacement supports templates, metavariable substitution, transformations, fix expansion, and named fixers.

Tau should begin with structural search. Rewriting can wait until its interaction with `patch`, stale ranges, concurrent edits, and file mutation queues has a complete safety design.

Relevant sources:

- `ast-grep/crates/core/src/matcher/pattern.rs`
- `ast-grep/crates/core/src/node.rs`
- `ast-grep/crates/config/src/rule/mod.rs`
- `ast-grep/crates/config/src/rule_config.rs`
- `ast-grep/crates/config/src/fixer.rs`

#### Indexing and performance

No persistent project AST index was found in the inspected CLI path. Normal execution walks files, reads each file, parses it, and matches it.

Performance techniques include:

- one cached parser per language per worker thread
- parallel traversal through `ignore::WalkParallel`
- a producer/consumer processing pipeline
- precomputed potential node kinds for patterns
- indexing rules by applicable node kind
- extracting literal fragments from patterns as cheap source-text prefilters
- skipping oversized files
- atomic result counters for early termination
- compiling outline rules once and reusing them across workers

These techniques are a strong starting point for Tau. They may remove the need for a persistent index over normal repository sizes.

Relevant sources:

- `ast-grep/crates/cli/src/utils/worker.rs`
- `ast-grep/crates/cli/src/utils/mod.rs`
- `ast-grep/crates/config/src/combined.rs`
- `ast-grep/crates/core/src/ops.rs`
- `ast-grep/crates/cli/src/outline/extract.rs`

#### Output

The CLI supports colored text, interactive fixes, JSON, file-name-only output, GitHub annotations, and SARIF. JSON results can include source text, byte and line ranges, language, replacement data, surrounding context, labels, and metavariable bindings.

Tau should not expose the CLI JSON contract directly. It should define a smaller stable result contract designed for locators, model context, and Tau rendering.

Relevant sources:

- `ast-grep/crates/cli/src/run.rs`
- `ast-grep/crates/cli/src/print/json_print.rs`
- `ast-grep/crates/cli/src/print/cloud_print.rs`

#### Deployment surfaces

The project ships native packages through npm, pip, Cargo, Homebrew, Scoop, and other managers. N-API exposes synchronous and asynchronous parsing, kind lookup, pattern configuration, file scanning, and dynamic-language registration. WebAssembly requires runtime parser registration and ships no predefined languages. The LSP stores versioned parsed documents in a `DashMap`, shares rules behind an `RwLock`, and currently uses full document synchronization.

This proves the Rust internals can support multiple embedding boundaries. Tau should choose its boundary based on harness reliability rather than assuming in-process calls are always better.

#### Odin feasibility

Odin is absent from the built-in grammar dependency list and `SupportLang` enum. It can implement ast-grep's language traits around an Odin Tree-sitter grammar.

Odin probably needs an expando character because `$VAR` is not a valid normal Odin identifier. `ast-grep-language` already includes preprocessing for languages that reject dollar-prefixed identifiers. Tau can implement the same contract for its Odin language.

Relevant source:

- `ast-grep/crates/language/src/lib.rs`

#### Main lessons

- Reuse `ast-grep-core` as a Rust library rather than depending on its executable.
- Keep Tau's public contract independent from ast-grep types.
- Reuse parser pooling, potential-kind indexing, literal prefilters, parallel walking, and early termination.
- Pin the dependency exactly because Tau will rely on library internals rather than a CLI compatibility boundary.
- Test Odin pattern preprocessing explicitly.
- Avoid dynamic grammar registration in the first release.
- Nested rewrite matches and broad textual metavariable replacement contain known precision limits.

### `ast-outline`

#### Architecture

`ast-outline` is a Python 3.10+ CLI. An adapter registry selects languages and handles traversal. Each adapter produces a shared `ParseResult` containing declaration trees and metadata. Renderers dispatch through an adapter-selected render family instead of branching on language names in core.

Its canonical model includes:

- declaration names and kinds
- signatures
- nesting
- visibility
- documentation
- byte and line ranges
- imports
- noise regions
- parse errors

Relevant sources:

- `ast-outline/src/ast_outline/adapters/__init__.py`
- `ast-outline/src/ast_outline/core.py`
- `ast-outline/src/ast_outline/cli.py`

This is the closest reference to Tau's recommended first capability boundary.

#### Grammar distribution

Python Tree-sitter and separate per-language grammar wheels are runtime dependencies. Supported grammar packages cover C#, Python, TypeScript, Java, Kotlin, Scala, Go, Rust, PHP, Markdown, YAML, C++, Ruby, CSS/SCSS, SQL, Lua, Swift, HTML, and Elixir. Vue composes HTML, TypeScript, and CSS grammars.

GDScript is handled by a handwritten scanner because no maintained PyPI grammar wheel exists. It preserves source positions through aligned display and shadow strings.

This is useful precedent for isolating language-specific compromises behind one adapter interface. It also shows why Tau should own exact source ranges and avoid allowing grammar packaging to leak into tool contracts.

Relevant sources:

- `ast-outline/pyproject.toml`
- `ast-outline/src/ast_outline/adapters/python.py`
- `ast-outline/src/ast_outline/adapters/cpp.py`
- `ast-outline/src/ast_outline/adapters/gdscript.py`
- `ast-outline/README.md`

#### Stateless operation

The project deliberately has no index, cache, embeddings, network access, MCP server, dependency graph, or call graph. Files are parsed on demand.

Directory `show` first performs grep-like definition scanning and then parses candidate files. Its grep path reads bytes and uses text hits before Tree-sitter parsing; project documentation says this avoids roughly 95% of parses in typical repositories. Ignored directories are pruned during traversal.

This supports beginning without a persistent index. Cheap textual filtering plus fast native parsing may be enough.

Relevant sources:

- `ast-outline/src/ast_outline/cli.py`
- `ast-outline/src/ast_outline/grep.py`
- `ast-outline/src/ast_outline/adapters/__init__.py`

#### Capabilities and output

Commands are `outline`, `digest`, `show`, structural `grep`, `prompt`, `setup-prompt`, and `help`.

Text output includes line-ranged outlines and compact module or repository digests with size estimates, token estimates, and declaration counts. `show` supports suffix-qualified names such as `Foo.Bar.Method`.

JSON uses a stable versioned envelope. It serializes the declaration model, imports, byte regions, counts, and nested declarations. User-facing failures are valid JSON and exit successfully for batch-agent compatibility. Tau should instead use Pi's normal thrown-error semantics while preserving structured diagnostics.

Ambiguous `show` results return candidate locators without source. That forces a deliberate follow-up instead of dumping several bodies. Tau should copy this behavior.

Relevant sources:

- `ast-outline/src/ast_outline/core.py`
- `ast-outline/src/ast_outline/json_output.py`
- `ast-outline/README.md`

#### Correctness lessons

- Preserve original source bytes for exact body extraction.
- Length-preserving preprocessing keeps ranges valid when languages need source normalization.
- Gather imports and noise metadata during the main AST walk rather than traversing repeatedly.
- Tree-sitter returns recoverable trees for invalid syntax. Count `ERROR` and `MISSING` nodes and report possible incompleteness.
- Text-first candidate filtering is approximate. Synthetic names need a fallback.
- Imports are architectural hints rather than complete dependency semantics.

#### Odin

Odin is unsupported in this checkout. There is no `.odin` mapping, adapter, or grammar dependency.

### `errata`

#### Architecture

`errata` contains a working Odin-specific prototype. A TypeScript Pi extension registers a `surface` tool and invokes a native Odin CLI through `mise run outline`. The native code is built with `odin build ... -o:speed` and run as a one-shot process.

The Odin entrypoint treats allocations as process-lifetime resources and exits after printing. There is no persistent cache or index.

Relevant sources:

- `errata/.pi/extensions/surface.ts`
- `errata/mise.toml`
- `errata/tools/outline/main.odin`

#### Parser integration

The implementation uses Odin's compiler AST, parser, and tokenizer packages directly. Package mode calls `parser.parse_package_from_path`. File mode builds an `ast.Package` and `ast.File`, loads the source, and calls `parser.parse_package`.

It walks top-level `ast.Value_Decl` nodes and reads names, values, mutability, attributes, visibility, and source positions. It classifies procedures, procedure groups, and Odin type-expression variants. Remaining expressions become constant or variable rows.

The parser comes from the pinned Odin toolchain's `core:odin/parser`; there is no repository-owned Tree-sitter grammar. OLS is pinned separately but is not used by the tool.

Relevant source:

- `errata/tools/outline/outline.odin`

#### Capability and output

The native command supports:

- one file or package directory
- public declarations by default
- optional private declarations
- optional line spans
- repeated exact-name filters

Rows are grouped by visibility and kind. Signatures come from source slices and have whitespace compacted. Multiline type expressions can fall back to a short kind label instead of dumping bodies.

The Pi wrapper adds:

- schema validation
- cancellation
- a 30-second timeout
- compact collapsed rendering
- standard line and byte truncation
- a temporary file for full output

Its machine contract is weak: the Pi extension counts declarations by leading spaces in human-readable output. Tau's engine should return structured data and render text separately.

Relevant sources:

- `errata/.pi/extensions/surface.ts`
- `errata/tools/outline/outline.odin`

#### Performance and cache

The helper uses an optimized native build and avoids body output. Source text is sliced by AST offsets instead of reconstructed. Name filtering still happens after the target is fully parsed and scans requested names linearly. Every invocation reparses the target.

The one-shot design is likely fast enough for a prototype. Tau's resident worker removes repeated process startup and lets parsers and trees remain warm.

#### Odin coverage

Fixtures cover:

- distinct types
- aliases
- structs
- enums
- bit sets
- constants
- variables
- procedures
- procedure groups
- package-private declarations
- file-private declarations

Relevant source:

- `errata/tools/outline/fixtures/geom/vec.odin`

The persisted plan says the tool is planned or unimplemented even though the implementation exists. Documentation and implementation have drifted.

#### Main lessons

- A language-specific native worker can stay small and useful.
- Public surface is a good default.
- Line spans provide a clean path to targeted reads.
- The Pi wrapper should remain thin and handle cancellation, timeouts, truncation, and rendering.
- Compiler-internal APIs require a pinned toolchain.
- Syntactic signatures are not type-checked.
- Unhandled AST expression variants can be silently misclassified.
- Human-formatted output is a poor machine protocol.

## Comparative summary

| Concern | `ast-bro` | `ast-grep` | `ast-outline` | `errata` | Tau takeaway |
| --- | --- | --- | --- | --- | --- |
| Runtime | Rust | Rust | Python | Odin + TypeScript | Rust worker with TypeScript Pi wrapper |
| Parser | Tree-sitter through ast-grep | Tree-sitter | Tree-sitter grammar wheels | Odin compiler parser | Tree-sitter with owned Odin validation |
| Main strength | Broad agent context system | Structural matching engine | Small declaration model | Accurate Odin prototype | Combine narrow outline model with ast-grep matching |
| Persistent index | Graph and search caches | None for normal scans | None | None | Start with process memory only |
| Parallel traversal | Yes | Yes | Limited/stateless | No | Use `ignore` and `rayon` |
| Agent integration | CLI/MCP wrappers | CLI/APIs | CLI and prompt setup | Real Pi tool | Native Pi tools owned by Tau |
| Odin | No | Feasible custom language | No | Yes | Treat Odin grammar quality as first-order work |
| Output contract | Text plus versioned JSON | Rich CLI JSON | Text plus stable JSON | Human text | Structured engine result plus compact model rendering |
| Best idea to copy | Budgeted context and warm cache | Matching and prefilters | IR, locators, ambiguity | Public surface and Pi wrapper | Small core first |
| Main trap | Scope and cache complexity | Exposing matcher internals | Python deployment and unsupported languages | One-shot process and brittle text protocol | Keep boundaries strict |

## Current Tau integration surface

### Explore extension ownership

`packages/agent/extensions/explore/index.ts` currently creates shared tool-row, read-cache, and read-snapshot state. It registers:

- `ls`
- `find`
- `grep`
- `read`
- autoread behavior
- `/read-stats`

This is the natural ownership point for AST exploration because it already controls filesystem discovery and read behavior.

`packages/agent/extensions/explore/read.ts` overrides the normal read definition. It resolves against `ctx.cwd`, reads bytes, delegates images and invalid UTF-8 to Pi's base read tool, tracks complete-file baselines, and can return diffs or unchanged markers on later reads.

An AST-aware read policy can be integrated directly into this implementation. Doing so gives it typed access to read parameters, read history, AST tool state, and Tau's renderer. A separate generic `tool_call` handler could block reads, but it would create an extra policy layer with less result control.

Relevant sources:

- `packages/agent/extensions/explore/index.ts`
- `packages/agent/extensions/explore/read.ts`
- `packages/agent/extensions/explore/read-cache.ts`
- `packages/agent/extensions/explore/README.md`

### Pi tool capabilities

Pi extensions can:

- register strict custom tools
- override built-in tools by name
- add prompt snippets and tool-specific guidance
- block or modify calls through `tool_call`
- modify results through `tool_result`
- start and stop session-scoped resources
- execute child processes with cancellation and timeouts
- render compact and expanded tool rows
- activate tools dynamically

Important Pi requirements:

- String enums should use `StringEnum` for provider compatibility.
- Tools must bound output. Pi's normal limits are 50 KB or 2,000 lines.
- Errors are signaled by throwing from `execute`.
- Long-lived processes should start during `session_start` or lazily from a tool, never from the extension factory.
- Resources must close in an idempotent `session_shutdown` handler.
- If AST rewriting is added later, it must use Pi's per-file mutation queue.
- Overridden built-in tools must preserve expected result shapes where built-in UI or session logic relies on them.

Primary documentation:

- `/Users/shanepadgett/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`

### Tau events

Tau emits `tau:file-mutation.applied` after `patch`. Its payload includes the tool call, working directory, overall status, and per-file change summaries. The AST worker wrapper can use this event to invalidate affected paths immediately.

The event does not currently provide a complete Tree-sitter `InputEdit`. The first implementation should invalidate and fully reparse the changed file on demand. Incremental edits can be added only if Tau later emits exact old and new byte and point ranges or the worker computes a reliable edit from cached and current source.

Relevant sources:

- `packages/agent/extensions/patch/index.ts`
- `packages/agent/shared/events.ts`
- `packages/agent/docs/extending-tau-agent.md`

### Existing native-helper precedent

`packages/agent/extensions/appshot/native-helper.ts` builds and caches a native Swift helper. It hashes source, selects architecture, validates the cached executable, uses atomic rename, handles cancellation, and invalidates the helper after execution failure.

This is useful lifecycle precedent. It is macOS-specific and builds from an installed toolchain, so it is not a complete model for a cross-platform Rust release. Tau AST should normally ship prebuilt platform artifacts.

### Package layout facts

`packages/agent/package.json`:

- publishes all `extensions/*/index.ts` entries through Pi package discovery
- currently has no parser or AST runtime dependency
- declares Node `>=22.19.0`
- ships TypeScript source, extensions, shared code, prompts, skills, themes, docs, and schemas

A native AST engine will require new release artifacts and package selection logic. Exact workspace paths and npm package names remain undecided.

## Native boundary decision

### Recommended: long-lived package-private worker

Properties:

- Rust process started lazily by Tau.
- One process per Tau extension/session runtime unless benchmarks justify broader sharing.
- Framed, versioned JSON requests and responses over stdin/stdout.
- Request IDs allow concurrent dispatch and cancellation.
- Requests are coarse: outline targets, fetch symbols, or scan patterns. There is no one-IPC-call-per-AST-node API.
- The worker retains parser pools, source buffers, syntax trees, and declaration summaries.
- Tau restarts the worker after protocol failure or crash.
- `session_shutdown` closes stdin, waits briefly, and kills if needed.
- stdout is reserved for protocol frames. Diagnostics go to bounded stderr.

Benefits:

- Native parser faults do not take down Pi.
- Node and Bun share the same child-process boundary.
- Warm parser and tree state survives tool calls.
- Native artifact selection is explicit.
- The worker implementation remains reusable without exposing a user CLI.

Costs:

- One executable is needed for every supported OS, CPU, and libc combination.
- Tau must implement protocol framing, process restart, backpressure, and cleanup.
- Source and result data cross a process boundary.
- A worker consumes more memory than an in-process addon.

For coarse operations, the isolation and runtime compatibility are worth more than microsecond-level call overhead.

### Alternative: napi-rs addon

Node-API is stable across supported Node major versions when an addon uses only Node-API. It does not remove OS, CPU, libc, deployment-target, or linked-library differences.

Current napi-rs v3 provides Rust exports, generated TypeScript loaders, cross-build tooling, and optional per-platform npm packages. Its maintained matrix includes common macOS, Windows, Linux glibc, and Linux musl targets. Release publication spans a root package and exact-version platform packages and can be partially published if a release fails midway.

Bun implements Node-API and says most addons work. napi-rs classifies Bun support as best-effort, and its Bun CI is non-blocking. Open Bun Node-API issues include event-loop and crash behavior.

An in-process addon should be reconsidered only if measurements show framed IPC is a meaningful bottleneck and Tau can make every claimed Node and Bun platform a blocking release test. A native crash in this shape crashes Pi.

Primary sources:

- <https://nodejs.org/api/n-api.html>
- <https://napi.rs/docs/introduction/getting-started>
- <https://napi.rs/docs/more/support-compatibility>
- <https://napi.rs/docs/cross-build>
- <https://napi.rs/docs/deep-dive/release>
- <https://bun.sh/docs/runtime/node-api>

### Rejected initial boundaries

#### External CLI dependency

This preserves the central problem: separate installation, version discovery, subprocess startup per call, and agent behavior controlled through prose. A private worker distributed and controlled by Tau avoids those failures.

#### WebAssembly

WASM simplifies some artifact distribution, but grammar registration, filesystem walking, threading, source transfer, and runtime initialization complicate the hot path. It also gives up some native performance and process isolation. There is no current evidence that Tau needs browser portability.

#### Pure TypeScript parser stack

This would produce uneven language coverage and would not meet the native-speed goal for broad repository scans. It also leaves Odin unresolved.

#### One-shot process per tool call

`errata` proves this is viable for a prototype. Tau would repeatedly pay process startup, grammar initialization, and source parsing. A resident worker is only modestly more complex and directly supports the desired warm behavior.

## Proposed engine model

### Grammar registry

Each supported language needs:

- canonical language ID
- file extensions and filename rules
- statically linked Tree-sitter grammar
- ast-grep language implementation
- optional pattern expando preprocessing
- declaration adapter
- fixtures tied to the exact grammar revision

Language support should have explicit levels:

1. Parsing and diagnostics
2. Structural search
3. Declaration outline and symbol extraction
4. Import extraction
5. Higher semantic approximations such as dependencies or calls

Do not claim full support merely because a parser can produce a tree.

### Canonical representation

The first model should contain only data required by approved tools. The current conceptual shape is:

```text
FileSummary
  path
  language
  source fingerprint
  byte length
  line count
  parse diagnostics
  imports
  top-level declarations

Declaration
  stable result-local id
  kind
  name
  visibility
  signature
  documentation
  full source range
  body range
  nested declarations
```

Exact field optionality and serialization shape remain design work. The important boundary is that Pi never has to inspect grammar-specific node kinds.

### Source locators

Outline and search results should return opaque locators. A locator needs enough information to detect stale source and recover the exact declaration without repeating a fuzzy lookup. Likely components are:

- canonical path
- language
- byte range or declaration identity
- source fingerprint

The model-facing representation can remain short. Structured tool details can retain the complete locator.

When a result is ambiguous, return candidate locators and no source body. This avoids context dumps and forces a precise follow-up.

When a locator is stale, return a clear stale-source error and ask for a fresh outline or search. Never trust an old byte range after mutation.

### Parsing and cache

Initial cache scope should be in-process memory only.

For each canonical file path retain:

- source bytes
- language and grammar version
- filesystem metadata
- strong source fingerprint when metadata requires verification
- parsed tree
- declaration summary
- last-access information for bounded eviction

Freshness behavior:

1. Invalidate immediately after a known Tau patch event.
2. Before reuse, compare filesystem metadata.
3. If metadata changed or is insufficient, verify source bytes or a fast hash.
4. Reparse fully on mismatch.
5. Reject locators whose fingerprint no longer matches.

Full reparsing is acceptable initially. Tree-sitter incremental parsing requires an accurate `InputEdit`, including old and new byte offsets and row/column points. Approximate edits create corrupted trees. Add incremental updates only after exact edit information is available and benchmarked.

Persistent indexes should wait. They require:

- schema versioning
- grammar-version invalidation
- worker-version invalidation
- crash-safe writes
- lock behavior across processes
- repository move handling
- generated and ignored path rules
- cleanup and compaction

Warm memory state provides most interactive value with far less stale-data risk.

### Repository walking

Use `ignore` so traversal follows gitignore behavior and prunes ignored directories early. Use a parallel walker and per-thread parsers. File type detection should happen before reads. Structural searches should:

1. derive literal fragments and potential AST node kinds from the pattern
2. filter paths by language
3. scan source bytes for required literals when available
4. parse only candidates
5. search only applicable node kinds
6. stop when the result limit is reached
7. honor cancellation throughout traversal

Oversized-file policy and default result limits need measurements from real Tau and Odin repositories.

### Protocol

Use an explicit protocol version from the first request. Prefer length-prefixed JSON frames over line-delimited JSON because source snippets and diagnostics naturally contain newlines.

The protocol needs:

- handshake with protocol and engine versions
- request ID
- operation name
- working root
- operation payload
- success result or typed error
- cancellation request
- bounded diagnostic channel

Do not use Rust binary serialization for the first contract. JSON costs little for coarse requests, is easy to inspect in tests, and avoids the binary schema evolution failure documented by `ast-bro`.

Protocol errors should distinguish:

- unsupported language
- unreadable path
- path outside allowed root, if Tau enforces a root boundary
- parse completed with diagnostics
- invalid structural pattern
- stale locator
- ambiguous symbol
- cancelled request
- internal worker failure
- incompatible protocol or grammar

### Process behavior

- Start lazily on the first AST tool call.
- Avoid work in the extension factory.
- Share one startup promise so parallel first calls do not spawn duplicate workers.
- Bound stderr retained in errors.
- Propagate Pi's `AbortSignal` to a protocol cancellation request.
- Kill and restart if cancellation fails to settle the worker.
- Treat malformed frames or unexpected worker exit as invalidating all process-local locators and cache state.
- Close cleanly on `session_shutdown`, reload, new session, resume, and fork lifecycle transitions.

Whether worker state should survive Tau session replacement is unresolved. Session-scoped ownership is safer initially and matches Pi's extension lifecycle.

## Proposed Pi tools

Names remain subject to product review. Separate tools are preferred over one large action option bag because each operation can have a strict schema and focused description.

### `outline`

Purpose: inspect the structural surface of one source file, package directory, or repository subtree without implementation bodies.

Expected result information:

- language and target summary
- declaration hierarchy
- signatures
- visibility
- imports
- documentation where it materially identifies declarations
- line and byte spans
- parse diagnostics
- declaration locators
- source bytes avoided or comparable measurement for read statistics

Directory output needs a hard budget and deterministic order. Large targets may require a digest mode or separate repository-level tool; this remains open.

### `symbol`

Purpose: return the exact source represented by one locator.

Behavior:

- verify the source fingerprint
- return one declaration body and enough enclosing context to understand it
- report a stale locator instead of guessing
- keep output within normal Pi truncation limits
- preserve exact source text

The first contract should accept a locator rather than a broad mix of path, name, kind, and fuzzy options. Symbol discovery belongs to `outline` and `ast_search`.

### `ast_search`

Purpose: search code structurally using ast-grep-style code patterns and metavariables.

Behavior:

- explicit language or language inferred from a constrained target
- one or more target paths
- bounded result count
- compact match previews
- line and byte ranges
- metavariable bindings where useful
- locators for exact follow-up reads
- cancellation and early termination

Repository search should compile the pattern once and reuse it across workers.

### Deferred tools

- Dependency and reverse-dependency exploration
- Callers and callees
- Impact analysis
- Budgeted context packs
- Semantic related-code search
- Structural rewrite

These should be added only after observed Tau workflows show which operation deserves a strict contract.

## Output strategy

The worker returns structured data. The Tau tool produces two views:

- compact plain text in `content` for the model
- complete structured information in `details` for rendering, metrics, and state

Default model output should be line-oriented and easy to follow with another tool call. JSON should not be dumped into model context merely because the worker speaks JSON.

Output rules:

- deterministic ordering
- explicit parse warnings
- explicit truncation
- no hidden omission of a requested target body
- no multiple ambiguous bodies
- concise paths relative to the working root
- source line spans for human and model navigation
- byte spans retained in structured details
- hard limits on lines, bytes, matches, and estimated tokens

Tau's standard 50 KB and 2,000-line limits remain the outer ceiling. AST tools should usually produce much less.

## Read-policy integration

### Desired behavior

For supported code, discovery should proceed through structural tools and targeted source retrieval instead of immediate whole-file reads.

A future enforced policy can follow this sequence:

1. The agent requests a whole-file read.
2. Tau recognizes a supported source language and checks file size.
3. If structural exploration is required, Tau blocks the whole-file read with a direct instruction to use `outline`.
4. `outline` returns declaration locators and spans.
5. The agent calls `symbol` or a targeted ranged read.
6. Tau records avoided source bytes in read statistics.

### Why enforcement should wait

A faulty grammar or adapter can omit the declaration the agent needs. Blocking source access before parser correctness is demonstrated can strand the agent or cause incorrect edits. Enforcement should follow fixtures, repository trials, and measurements.

The first development stage can expose the tools and measure behavior. The enforcement stage should then apply only where Tau has a supported language adapter and acceptable parse diagnostics.

### Required escape behavior

Normal read behavior must remain available for:

- prose and documentation
- configuration and data files
- unsupported languages
- small source files where an outline saves no context
- files with severe parse failures
- exact formatting or comment-sensitive work outside a declaration
- continuation after explicit truncation

Targeted ranged reads should remain available because outlines intentionally omit implementation details.

The exact size threshold must come from measurements. Hardcoding a guessed threshold would move context waste around rather than prove savings.

### Do not silently replace read results

Returning an outline from a successful call named `read` changes the meaning of the tool and can make the model believe it has authoritative file contents. Blocking with a precise reason is safer than silently substituting a summary.

### Enforcement limit

Tau can enforce this policy through its official `read` tool. An unrestricted `bash` tool can still read files through `cat`, `awk`, Python, Node, Perl, compiler commands, or custom executables. Pattern-blocking common shell commands cannot provide a real guarantee.

Absolute filesystem-read enforcement requires one of:

- disabling unrestricted shell access
- routing shell execution through a sandbox with filesystem capabilities
- modifying Pi so tools receive restricted filesystem handles rather than ambient process access

Until then, Tau can strongly control normal agent exploration while documenting that the shell remains an escape route.

## Odin research

### Established grammar

The established distributable grammar is:

- <https://github.com/tree-sitter-grammars/tree-sitter-odin>

As of 24 July 2026:

- crate version observed: `1.3.0`
- license: MIT
- Rust bindings use `tree-sitter-language`
- generated with Tree-sitter 0.24.5
- several 2026 Odin syntax updates remain open, including typed procedures and newer `for-in` syntax

Tau must test its generated language against the selected Tree-sitter 0.26 runtime. `Parser::set_language` detects incompatible grammar/runtime ABI versions, but successful loading does not prove syntax completeness.

### Newer unlicensed grammar

`krnowak/my-tree-sitter-odin` was active on 23 July 2026 but had no declared license or `LICENSE` file during research:

- <https://github.com/krnowak/my-tree-sitter-odin>

Tau cannot safely redistribute or incorporate it without a license. It may still be useful for understanding current grammar changes, subject to normal source-use rules.

### Recommended Odin policy

- Begin from the MIT grammar.
- Pin the exact grammar revision.
- Maintain Tau-owned conformance fixtures against current Odin.
- Carry a small compatible patch set when upstream lags.
- Contribute fixes upstream where practical.
- Surface parse diagnostics rather than claiming complete support.
- Compare declaration extraction against Odin's compiler parser on fixture corpora.
- Test ast-grep metavariable expansion because `$NAME` is not a normal Odin identifier.

### Direct compiler parser alternative

`errata` proves that Odin's compiler parser can provide accurate declaration data. Its disadvantages for Tau are:

- compiler-internal API dependence
- pinned Odin toolchain requirement
- separate parser backend and build pipeline
- poor fit with shared ast-grep structural search
- potential churn as compiler internals change

Keep it as a correctness oracle and fallback architectural option. Do not start with two Odin parser implementations.

## Performance baseline

Native implementation alone does not guarantee useful latency. The main techniques to preserve are:

- one resident worker instead of process startup per call
- parser reuse per language and worker thread
- source/tree/declaration caching in memory
- gitignore-aware directory pruning
- parallel file walking
- literal source prefilters before AST parsing
- potential-node-kind filtering
- compile patterns once per request
- early stop at result limits
- skip or explicitly handle oversized files
- deterministic compact output
- avoid embeddings and graph construction in the normal path

Metrics needed during the spike:

- cold worker startup
- first parse per grammar
- warm outline latency
- warm symbol latency
- repository structural search latency
- files discovered, filtered, read, and parsed
- parser error counts
- source bytes read by the worker
- source bytes returned to the model
- output bytes avoided compared with whole-file reads
- worker resident memory
- cache hit and invalidation behavior
- IPC serialization and transfer time

Benchmark at least:

- the Tau repository for TypeScript
- `errata` and another current Odin repository
- small files where process and protocol overhead dominate
- large generated or malformed files
- repeated calls before and after patching a file

The sidecar-versus-N-API decision should be reopened only if these measurements show IPC is material.

## Packaging and release

The likely npm shape is one JavaScript selector package plus optional exact-version platform packages, following common native-package practice. Exact names are undecided.

Potential target matrix:

- macOS arm64
- macOS x64
- Linux x64 glibc
- Linux arm64 glibc
- Linux x64 musl if Tau supports Alpine
- Linux arm64 musl if Tau supports Alpine on arm64
- Windows x64 MSVC
- Windows arm64 only if Tau claims it

Every claimed target needs a blocking smoke test that:

1. installs the published package normally
2. resolves the expected artifact
3. starts the worker
4. completes the protocol handshake
5. parses a TypeScript fixture
6. parses an Odin fixture
7. performs a structural search
8. handles cancellation and shutdown

Release concerns:

- minimum glibc version
- minimum macOS deployment target
- executable permissions in npm archives
- code signing or quarantine behavior on macOS
- Windows process cleanup
- exact root/platform package version alignment
- partial npm publication recovery
- checksums or embedded build metadata
- grammar and protocol version reporting

Building from source during installation should not be the normal path. It requires a Rust toolchain and undermines the built-in experience.

## Suggested implementation slices

Each slice should leave a wired, testable result.

### Slice 1: native feasibility spike

- Create the Rust worker skeleton.
- Add framed protocol handshake and one outline request.
- Compile TypeScript and the selected Odin grammar statically.
- Produce declarations, ranges, and parse diagnostics.
- Benchmark cold and warm calls over Tau and `errata`.
- Validate Tree-sitter runtime compatibility with the Odin grammar.

Exit condition: warm calls are fast enough, current Odin fixtures parse acceptably, and the worker boundary functions under Tau's supported runtime.

### Slice 2: canonical outline and locators

- Define Tau's declaration representation.
- Implement TypeScript and Odin adapters.
- Preserve source bytes and exact ranges.
- Add source fingerprints and stale-locator rejection.
- Implement exact symbol retrieval.
- Add ambiguity behavior and deterministic compact rendering.

Exit condition: outline plus symbol can replace common discovery reads without hiding parser errors.

### Slice 3: Pi integration

- Register the initial tools from Tau's exploration surface.
- Start the worker lazily.
- Add cancellation, restart, bounded stderr, and session shutdown.
- Add compact and expanded tool rendering.
- Add standard truncation and read-savings measurements.
- Invalidate worker paths after `tau:file-mutation.applied`.

Exit condition: Tau owns installation, lifecycle, invocation, and rendering. No user-facing CLI setup exists.

### Slice 4: structural search

- Integrate `ast-grep-core` behind Tau's contract.
- Add Odin metavariable preprocessing.
- Add parallel gitignore-aware traversal.
- Add literal and potential-kind prefilters.
- Add maximum results, cancellation, and deterministic locators.

Exit condition: repository scans are bounded, fast, and return precise follow-up targets.

### Slice 5: read enforcement

- Measure savings and failure cases in real agent sessions.
- Define the supported-code and parse-health criteria.
- Block eligible whole-file reads with a precise redirect.
- Preserve targeted reads and required fallback paths.
- Extend `/read-stats` with AST savings.

Exit condition: enforcement reduces context without preventing correct investigation or edits.

### Later slices

Only observed workflows should justify:

- dependency extraction
- callers and callees
- context packing
- persistent cache
- embeddings
- rewrites
- more languages

## Testing strategy

### Grammar fixtures

Every language adapter needs fixtures for:

- each declaration kind
- nested declarations
- visibility forms
- multiline signatures
- documentation
- imports
- anonymous or synthetic declarations
- malformed and incomplete source
- grammar-specific edge syntax
- source ranges with multibyte UTF-8
- CRLF input

Odin additionally needs current language-release syntax and comparison with compiler-parser output.

### Golden output

Keep separate goldens for:

- structured worker result
- compact model text
- expanded TUI rendering where appropriate

Do not make the TypeScript wrapper parse human-formatted native output as `errata` currently does.

### Cache and locator tests

- unchanged metadata and source reuse
- metadata change with unchanged content
- same-size same-timestamp content replacement where the platform permits it
- Tau patch invalidation
- external modification invalidation
- stale locator after insertion before a declaration
- stale locator after declaration deletion
- worker restart invalidating process-local state
- canonical path and symlink behavior

### Protocol tests

- partial frame reads and writes
- multiple queued requests
- request cancellation
- worker crash mid-request
- malformed frame
- protocol version mismatch
- bounded stderr
- clean and forced shutdown

### Tool tests

- strict schemas
- path normalization, including Pi's common leading `@` case
- relative and absolute paths
- abort propagation
- compact and expanded output
- standard truncation
- parser diagnostics visible to the model
- ambiguous result behavior
- read-policy fallback

### Performance regression tests

Benchmarks should be recorded separately from correctness tests. Do not make noisy wall-clock thresholds block normal unit tests. Release or scheduled benchmarks can compare:

- cold versus warm calls
- serial versus parallel scan
- literal-prefilter hit rates
- cache memory growth
- source/model byte reduction

## Risks

### High: Odin grammar lag

The distributable grammar is behind current syntax. Tau may need to maintain patches. Missing syntax can silently damage outlines unless parse diagnostics and fixtures are strict.

### High: premature read blocking

If Tau enforces AST-first exploration before grammar and adapter confidence, agents can miss code or become unable to inspect it. Enforce only after evidence.

### Medium: native release matrix

Platform packages, libc variants, executable permissions, and partial publication add operational work. Unsupported targets must fail with a clear installation or startup error.

### Medium: stale source

Cached trees and byte ranges can look plausible after edits. Fingerprints, patch invalidation, stat verification, and stale-locator rejection are mandatory.

### Medium: parser recovery

Tree-sitter often produces a tree for invalid files. A successful parse call does not imply a complete outline. Diagnostics must be part of every file result.

### Medium: native addon temptation

N-API removes IPC and also removes the crash boundary. Bun compatibility is weaker than Node-API's Node guarantee. Choose it only from measurements.

### Medium: feature growth

`ast-bro` demonstrates a compelling roadmap and the cost of implementing all of it. Graphs, context ranking, semantic search, and caches can consume the project before the basic tools are trusted.

### Low: Tree-sitter Rust foundation

Tree-sitter's Rust API is mature. Current crate research found version 0.26.11 released on 12 July 2026, MIT licensed, with incremental parsing through edited prior trees and compatibility checks in `Parser::set_language`.

### Low: structural matching foundation

`ast-grep-core` already solves the main AST pattern mechanics. The risk is dependency API churn, handled by exact pinning and Tau-owned boundary types.

## Open decisions

- Final tool names.
- Whether directory and repository digests belong in `outline` or a separate tool.
- Exact declaration and protocol schemas.
- Source fingerprint algorithm.
- Worker cache size and eviction policy.
- One worker per session, project, or Tau process.
- Initial supported operating-system matrix.
- Whether Linux musl is required.
- Whether TypeScript and Odin alone are enough for the first release or Rust should join the initial corpus.
- Exact Odin grammar revision and patch strategy.
- Read-enforcement size and parse-health thresholds.
- Whether AST tools are always active or dynamically loaded. They are core exploration tools, so always active is currently the simpler position.
- How AST savings integrate with `/read-stats` without overstating avoided tokens.
- Whether a repository root boundary should be enforced by the worker.
- Whether external file-watch invalidation is useful after stat-on-access behavior is implemented.

## Recommended decisions unless experiments disprove them

- Rust worker, TypeScript Pi wrapper.
- Long-lived package-private sidecar before N-API.
- Versioned length-prefixed JSON protocol.
- `tree-sitter` plus `ast-grep-core` as internal dependencies.
- Statically compiled grammars.
- TypeScript and Odin as the first language pair.
- In-memory cache only.
- Full reparse after mutation initially.
- Separate outline, exact-symbol, and structural-search tools.
- Opaque fingerprinted locators.
- Compact text for model context and structured details for Tau.
- No rewrite, graphs, embeddings, or persistent index in the first implementation.
- Read enforcement only after correctness and savings measurements.

## Source inventory

### Local `ast-bro` sources

- `Cargo.toml`
- `README.md`
- `Makefile`
- `wiki/architecture.md`
- `wiki/calls.md`
- `wiki/context.md`
- `wiki/deps.md`
- `wiki/search.md`
- `wiki/squeeze.md`
- `src/lib.rs`
- `src/core.rs`
- `src/file_filter.rs`
- `src/main_helpers.rs`
- `src/adapters/base.rs`
- `src/adapters/markdown.rs`
- `src/adapters/sql.rs`
- `src/graph_cache/shared.rs`
- `src/graph_cache/cache.rs`
- `src/run/mod.rs`
- `src/search/cache.rs`
- `src/search/chunker.rs`
- `src/search/download.rs`
- `src/search/embed.rs`
- `src/mcp/mod.rs`
- `cli-typescript/bin/install.js`
- `cli-python/ast_bro_cli/__init__.py`

### Local `ast-grep` sources

- `Cargo.toml`
- `README.md`
- `crates/core/Cargo.toml`
- `crates/core/src/language.rs`
- `crates/core/src/matcher/pattern.rs`
- `crates/core/src/node.rs`
- `crates/core/src/ops.rs`
- `crates/core/src/tree_sitter/mod.rs`
- `crates/language/Cargo.toml`
- `crates/language/src/lib.rs`
- `crates/dynamic/src/lib.rs`
- `crates/dynamic/src/custom_lang.rs`
- `crates/config/src/combined.rs`
- `crates/config/src/fixer.rs`
- `crates/config/src/rule/mod.rs`
- `crates/config/src/rule_config.rs`
- `crates/cli/src/lib.rs`
- `crates/cli/src/run.rs`
- `crates/cli/src/scan.rs`
- `crates/cli/src/lang/lang_globs.rs`
- `crates/cli/src/outline/extract.rs`
- `crates/cli/src/print/json_print.rs`
- `crates/cli/src/print/cloud_print.rs`
- `crates/cli/src/utils/mod.rs`
- `crates/cli/src/utils/worker.rs`
- `crates/napi/src/lib.rs`
- `crates/wasm/README.md`
- `crates/lsp/src/lib.rs`

### Local `ast-outline` sources

- `README.md`
- `pyproject.toml`
- `scripts/install.sh`
- `src/ast_outline/cli.py`
- `src/ast_outline/core.py`
- `src/ast_outline/grep.py`
- `src/ast_outline/json_output.py`
- `src/ast_outline/adapters/__init__.py`
- `src/ast_outline/adapters/base.py`
- `src/ast_outline/adapters/python.py`
- `src/ast_outline/adapters/cpp.py`
- `src/ast_outline/adapters/gdscript.py`

### Local `errata` sources

- `.pi/extensions/surface.ts`
- `mise.toml`
- `docs/plans/odin-outline.md`
- `tools/outline/main.odin`
- `tools/outline/outline.odin`
- `tools/outline/fixtures/geom/vec.odin`

### Tau and Pi sources

- `packages/agent/package.json`
- `packages/agent/extensions/explore/index.ts`
- `packages/agent/extensions/explore/read.ts`
- `packages/agent/extensions/explore/read-cache.ts`
- `packages/agent/extensions/explore/grep.ts`
- `packages/agent/extensions/explore/README.md`
- `packages/agent/extensions/appshot/native-helper.ts`
- `packages/agent/extensions/patch/index.ts`
- `packages/agent/shared/events.ts`
- `packages/agent/docs/extending-tau-agent.md`
- `/Users/shanepadgett/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`

### Public research sources

- Tree-sitter Rust crate: <https://crates.io/crates/tree-sitter>
- Tree-sitter parser API: <https://docs.rs/tree-sitter/0.26.11/tree_sitter/struct.Parser.html>
- Tree-sitter tree API: <https://docs.rs/tree-sitter/0.26.11/tree_sitter/struct.Tree.html>
- Odin grammar: <https://github.com/tree-sitter-grammars/tree-sitter-odin>
- Odin grammar license: <https://github.com/tree-sitter-grammars/tree-sitter-odin/blob/master/LICENSE>
- Odin Rust binding: <https://github.com/tree-sitter-grammars/tree-sitter-odin/blob/master/bindings/rust/lib.rs>
- Newer unlicensed Odin grammar: <https://github.com/krnowak/my-tree-sitter-odin>
- Node-API: <https://nodejs.org/api/n-api.html>
- napi-rs getting started: <https://napi.rs/docs/introduction/getting-started>
- napi-rs runtime matrix: <https://napi.rs/docs/more/support-compatibility>
- napi-rs cross-builds: <https://napi.rs/docs/cross-build>
- napi-rs release process: <https://napi.rs/docs/deep-dive/release>
- Bun Node-API: <https://bun.sh/docs/runtime/node-api>
- Node child processes: <https://nodejs.org/api/child_process.html#child_processspawncommand-args-options>
- Bun subprocesses: <https://bun.sh/docs/api/spawn>

## Immediate next step

Write a focused implementation plan for Slice 1 only: Rust worker layout, exact protocol handshake, selected TypeScript and Odin grammar crates, fixture corpus, release-free local build path, and benchmark commands. Do not design the later graph, semantic-search, or enforcement systems into that spike.
