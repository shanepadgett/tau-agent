# Tau TypeScript Symbol Workflow

Status: proposed; no implementation approved
Captured: 24 July 2026
Depends on: `docs/plans/tau-ast-exploration-baseline.md`

## Decision requested

Approve a TypeScript and TSX workflow that lets an agent discover a symbol, inspect its contract and implementation, find direct references and tests, then replace one declaration or body without a whole-file or ranged `read`.

This proposal keeps `outline` and `symbol` as the main navigation path and adds three focused tools:

- `symbols` for repository-wide declaration discovery;
- `references` for Deno-resolved usages and their enclosing editable scopes; and
- `replace_symbol` for one fingerprint-checked replacement.

The work is TypeScript-specific where compiler semantics matter. Existing Odin, Go, Rust, C#, Java, Kotlin, and Swift behavior stays unchanged. General structural search, rename, import rewriting, call graphs, persistent indexes, and read enforcement remain deferred.

Approval covers the contracts and slices in this document only. Each gate near the end requires a separate go-ahead before implementation continues.

## Acceptance workflow

The first acceptance case is a Deno repository with an implementation in `src/dashboard/service.ts`, a public re-export through `src/dashboard/mod.ts`, and direct tests in `src/dashboard/service_test.ts`.

An agent must be able to:

1. Find `refreshDashboard` without knowing its path.
2. Retrieve its complete declaration with only the imports used by that declaration.
3. Find direct call sites, re-exports, type usages, and tests through Deno's resolver.
4. Retrieve the complete implementation declaration and enclosing `Deno.test` callback declaration by locator.
5. Replace the implementation body.
6. Replace the affected test callback.
7. See both mutations in normal Tau invalidation and mutation-event flows.

The successful transcript may use `outline`, `symbols`, `symbol`, `references`, and `replace_symbol`. It must not use:

- `grep`;
- whole-file `read`;
- ranged `read`;
- `bash` text extraction; or
- `patch` for the two source edits.

The workflow may still use ordinary reads for JSON, Markdown, SQL, and other unsupported formats.

## Product boundary

### Included

- Complete TypeScript and TSX declarations.
- Source-order module structure for imports, declarations, exports, and top-level side effects.
- Stable qualified symbol metadata inside opaque fingerprinted locators.
- Signature, declaration, and declaration-with-imports retrieval.
- Repository-wide exact, prefix, and fuzzy declaration discovery.
- Deno import-map and re-export resolution through `deno lsp`.
- Direct references classified by usage and source role.
- A locator for the nearest safe editable scope around each reference.
- One stale-safe replacement of a declaration or body.
- Compact model text, Pi-style collapsed rows, and bounded expanded output.

### Deferred

- `ast_search` and general ast-grep patterns.
- JavaScript and JSX.
- TypeScript projects whose semantic authority is `tsserver` rather than Deno.
- Automatic dependency downloads or cache population.
- General callers, callees, and transitive impact graphs.
- Rename and reference updates.
- Import insertion, removal, sorting, or rewriting.
- Insert-before, insert-after, move, and delete operations.
- Arbitrary AST rewrites.
- Persistent repository indexes.
- Package public-surface discovery through `package.json` or `deno.json` export maps.
- AST-first enforcement in `read`.
- Equivalent selective views, references, scopes, or replacement for other languages.

## Main architecture

Keep syntax and semantics behind separate process boundaries:

```text
Explore tools
  ├── outline
  ├── symbols
  ├── symbol
  ├── references
  └── replace_symbol
       │
       ├── framed Tau protocol
       │     ▼
       │   tau-ast Rust worker
       │     - TypeScript declaration adapter
       │     - exact source ranges and fingerprints
       │     - repository declaration discovery
       │     - reference classification and scope mapping
       │     - stale-safe replacement
       │
       └── LSP JSON-RPC
             ▼
           deno lsp
             - Deno module resolution
             - definitions
             - direct references
```

Tree-sitter remains the source of syntax ranges. Deno remains the source of Deno module and symbol resolution. Tau must not reimplement import-map, remote-module, npm, JSR, or Deno workspace semantics.

The TypeScript extension owns both child processes. `tau-ast` remains one session-scoped worker. A new `DenoSemanticClient` starts one `deno lsp` process per active Deno workspace root, lazily on the first semantic request. Both close during `session_shutdown`.

No generic language-server framework is part of this work. The provider has one job and one concrete server.

## Deno runtime policy

Semantic tools require `deno` on `PATH`. Repository symbol discovery and syntax-only `outline` and `symbol` views continue to work without Deno. A missing executable produces a direct semantic-tool error:

```text
Deno semantic analysis needs `deno` on PATH. Syntax outline and symbol retrieval still work.
```

Tau will run `deno lsp` over stdio and use the nearest ancestor `deno.json` or `deno.jsonc` as the workspace root. A semantic request outside such a workspace fails instead of guessing at project ownership.

Tau must never invoke `deno cache`, the LSP `deno/cache` request, or any command that populates Deno's cache. The language server may use dependencies already present in the user's Deno cache. An uncached dependency produces a bounded diagnostic and no automatic fetch:

```text
Dependency https://example.invalid/mod.ts is not cached. Tau did not fetch it.
```

Set `DENO_NO_UPDATE_CHECK=1` for the child. Preserve the user's existing `DENO_DIR` so already-cached dependencies remain resolvable. Do not use `deno info --json`; Deno documents that JSON shape as unstable.

The integration suite must prove the no-fetch rule with a local HTTP server. A fixture imports from that server, the cache starts empty, and a semantic request must leave the server request count at zero.

Primary references:

- <https://docs.deno.com/runtime/reference/lsp/>
- <https://docs.deno.com/runtime/fundamentals/modules/>
- <https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/>

## TypeScript declaration adapter

The generic `ast-grep-outline` TypeScript rules remain useful fallback evidence, but their compact signatures are too lossy for this workflow. Add a Tau-owned TypeScript adapter in the Rust worker and route TypeScript and TSX through it.

### Required declaration coverage

The adapter must preserve:

- multiline parameters and return types;
- type parameters, defaults, and constraints;
- function, method, and constructor overloads;
- abstract and declared members;
- complete type aliases;
- interfaces, enums, namespaces, and classes;
- function-valued properties and callback types;
- variable declarations with callable or typed initializers;
- access, export, async, generator, readonly, static, abstract, declare, and override modifiers;
- decorators; and
- attached JSDoc, including `@deprecated` text.

Overloads remain separate declarations with separate locators. Merged declarations also remain separate. Their qualified name may match; declaration kind, source range, and ordinal disambiguate them.

### Required ranges

Each TypeScript declaration carries:

```text
path
language
qualified name
declaration kind
source fingerprint
name range
declaration range
signature fragments
optional body range
parse certainty
```

`declaration range` includes attached JSDoc and decorators. `body range` includes the braces for block bodies and the complete expression for expression-bodied arrows. `name range` points at the identifier used for LSP requests.

Signature output is a source-faithful contract view. Functions and methods omit their implementation body. Classes include the class header and member signatures. Interfaces, type aliases, overload signatures, and declarations without implementation bodies are already contracts, so the complete declaration is their signature view.

Some signature views are assembled from multiple exact source fragments. They are readable but cannot be replacement targets. Only contiguous declaration and body ranges can be replaced.

### Parser degradation

Keep file-level `ERROR` and `MISSING` counts. Add declaration-level certainty:

- `certain`: no recovery node intersects the declaration or its required parent structure;
- `recovered`: a recovery node intersects the declaration; or
- `nearRecovery`: the declaration is adjacent to a recovery region that can change ownership or export interpretation.

Model output marks uncertain declarations and says why. `symbol` may retrieve them. `replace_symbol` rejects them. A plausible recovered range is not safe enough for mutation.

### Module structure

TypeScript file outlines switch from visibility-and-kind grouping to source order. They show four compact row types:

- imports;
- declarations;
- export statements; and
- top-level executable statements.

Imports and exports include module specifiers. Top-level executable statements get a short AST-derived label such as `call registerRoutes(...)`. Declaration and editable-scope rows receive locators. Structural rows that cannot be retrieved or edited do not receive fake locators.

Names-filtered output omits files with no matching declarations. It retains only imports and exports needed to explain the matched declarations.

## Locator contract

Numeric locators remain short, session-local handles in the TypeScript extension. The native token stays opaque to the model.

Version 2 locator payloads contain enough native state to validate and recover one exact target:

```text
locator version
canonical path
language
source fingerprint
locator kind: declaration | executableScope
qualified name
declaration kind
declaration range
name range
optional body range
parse certainty
```

The source fingerprint remains authoritative. Qualified names improve diagnostics and identity reporting; they do not permit fuzzy recovery after a mismatch.

Mutation rules stay strict:

- Any source change makes every locator for that file stale.
- A worker restart invalidates all numeric locators.
- A stale batch fails atomically.
- Replacement never searches for a similar declaration after staleness.
- Errors identify the stale numeric IDs and paths.

Reference-scope locators use the same token and can be passed directly to `symbol` and `replace_symbol`.

## Tool contracts

All string choices use Pi's `StringEnum`. Tool outputs stay below Pi's 50 KB and 2,000-line ceilings and apply tighter operation-specific limits.

### `outline`

Keep the current tool name and path ownership. TypeScript and TSX gain complete signatures, source-order module structure, qualified names, and localized parser warnings. Other languages keep their current rendering and extraction.

No new `outline` parameter is needed.

Example model result:

```text
src/dashboard/service.ts (TypeScript, 118 lines, 4.8 KB)

imports
1: { Database } from ../platform/database/mod.ts
2: { Principal } from ../authentication/mod.ts
3-6: { SearchCatalogInput, SearchCatalogResult } from ./types.ts

declarations
12-18(31): export interface DashboardService {
  refresh(input: SearchCatalogInput, principal: Principal): Promise<SearchCatalogResult>;
}

24-67(32): export async function refreshDashboard(
  database: Database,
  input: SearchCatalogInput,
  principal: Principal,
): Promise<SearchCatalogResult>

side effects
70: call registerDashboardMetrics(...)

exports
72: export { refreshDashboard as refresh };
```

### `symbols`

Purpose: find declarations recursively without knowing a file path.

Proposed required parameters:

```text
path        repository or subtree root
query       declaration name query
match       exact | prefix | fuzzy
kind        any | function | method | class | interface | type | variable | test | scope
visibility  public | all
limit       1..200
```

Exact matching is case-sensitive. Prefix matching is case-insensitive. Fuzzy matching uses a deterministic case-insensitive subsequence score with bonuses for contiguous text and identifier boundaries. Equal scores sort by relative path, start byte, kind, and qualified name.

The Rust worker performs a gitignore-aware recursive walk of `.ts` and `.tsx` files, parses candidates in parallel, and keeps a bounded in-memory declaration index keyed by canonical root and file fingerprint. There is no persistent index.

Example call and result:

```text
symbols(path=".", query="refreshDashboard", match="exact", kind="function", visibility="all", limit=20)

2 matches
src/dashboard/service.ts
24-67(31): function refreshDashboard

src/dashboard/legacy.ts
19-42(32): function refreshDashboard
```

### `symbol`

Keep batched locators. Replace the implicit one-shape retrieval with a required `view`:

```text
locators      one or more numeric locators
view          signature | declaration | declarationWithImports
contextLines  optional, declaration view only
```

Support matrix:

| View | TypeScript/TSX | Other current languages | Replacement target |
| --- | --- | --- | --- |
| `signature` | Yes | No | No |
| `declaration` | Yes | Yes | Yes |
| `declarationWithImports` | Yes | No | No |

`declarationWithImports` includes only import declarations that bind names used by the selected declaration. Namespace and side-effect behavior stays literal: a used namespace binding retains its whole import; unrelated side-effect imports are omitted. Each retained binding reports the source specifier. It also reports the Deno-resolved path when the semantic provider is available. Missing Deno or uncached dependencies leave the specifier unresolved without hiding the declaration source.

Example:

```text
24-67(31): refreshDashboard [declarationWithImports]

import type { Principal } from "../authentication/mod.ts";
import type { SearchCatalogInput, SearchCatalogResult } from "./types.ts";
import { Database } from "../platform/database/mod.ts";

Database → src/platform/database/mod.ts
Principal → src/authentication/mod.ts
SearchCatalogInput → src/dashboard/types.ts
SearchCatalogResult → src/dashboard/types.ts

export async function refreshDashboard(
  database: Database,
  input: SearchCatalogInput,
  principal: Principal,
): Promise<SearchCatalogResult> {
  ...
}
```

A successful `declaration` retrieval records the complete contiguous symbol as read for the locator and fingerprint. It authorizes replacement of either that declaration or its contained body range.

### `references`

Purpose: return direct Deno-resolved references to one TypeScript or TSX declaration and map each reference to its nearest editable scope.

Proposed required parameters:

```text
locator  one numeric declaration locator
limit    1..500
```

The tool sends the locator's `name range` to `textDocument/references`. LSP positions use UTF-16 columns; Rust ranges use bytes. Conversion in both directions must use current source text and must be tested with multibyte UTF-8 before the result reaches scope mapping.

Each result contains:

```text
reference path and range
relationship: exact
usage: call | type | import | reExport | read | write
source class: production | test | generated
optional enclosing scope locator
scope kind and qualified label
```

Deno's returned symbol references are `exact`. The result shape retains an explicit relationship field because any future syntactic approximation must identify itself as `inferred` or `ambiguous`. This slice does not invent approximate references when Deno cannot resolve a symbol.

Source classification rules are deterministic:

- `generated` when the file has an `@generated` or `DO NOT EDIT` header;
- `test` for `_test.ts`, `.test.ts`, `.spec.ts`, standard test directories, or a scope rooted at `Deno.test`, `describe`, `it`, or `test`; and
- `production` otherwise.

Generated classification takes precedence over test classification. Re-exports are a usage kind rather than a source class.

Example:

```text
4 exact references to refreshDashboard

production
src/dashboard/mod.ts:3:10 reExport
  public surface: refreshDashboard

src/routes/dashboard.ts:44:23 call
  scope 44: function handleDashboardRequest (38-58)

test
src/dashboard/service_test.ts:27:24 call
  scope 45: Deno.test "refreshes visible cards" (18-41)

src/dashboard/service_test.ts:62:24 call
  scope 46: Deno.test "rejects hidden cards" (54-74)
```

Editable scope mapping supports:

- functions and methods;
- constructors and accessors;
- arrow and function expressions assigned to variables or properties;
- object methods;
- `Deno.test`, `describe`, `it`, and `test` callbacks; and
- other call-expression callbacks with a stable callee-and-argument label.

Imports and re-exports may have no enclosing editable scope. Their result remains useful and carries no fake scope locator.

### Export status

TypeScript declarations report three separate facts:

```text
source export: exported | private
module surface: public | internal | unknown
export path: zero or more mod.ts hops
```

The native adapter extracts local exports, named re-exports, star re-exports, and aliases. The Deno provider resolves their module specifiers. Tau walks outward through `mod.ts` files under the selected workspace. A declaration reachable from a workspace `mod.ts` is public. A source export with no such path is internal. When parsing or resolution breaks the chain, status is unknown with a diagnostic.

This slice does not interpret `deno.json` export maps as public package boundaries. Import maps still work because Deno resolves the specifiers.

### `replace_symbol`

Purpose: replace one previously retrieved declaration or body.

Proposed required parameters:

```text
locator      one numeric locator
target       declaration | body
replacement  complete replacement source for that target
```

Execution order is fixed:

1. Resolve the numeric locator and confirm the same target view was retrieved successfully.
2. Enter Pi's `withFileMutationQueue()` using the canonical absolute path.
3. Ask the Rust worker to re-read the file and validate the locator fingerprint, target range, UTF-8 boundaries, and parser certainty.
4. Build the candidate source by replacing the exact byte range.
5. Parse the candidate and reject newly introduced `ERROR` or `MISSING` nodes.
6. Write through a same-directory temporary file, preserve permissions, and rename over the original.
7. Return old and new ranges, line counts, and fingerprints.
8. Emit `tau:file-mutation.applied` with source `replace_symbol`.
9. Invalidate every locator and open Deno document for the path.

The tool does not format, type-check, update imports, or repair references. The replacement is exact source supplied by the agent.

Example success:

```text
updated src/dashboard/service.ts body of refreshDashboard
24-67 → 24-71, 1.4 KB replaced
all locators for src/dashboard/service.ts are now stale
```

Example failures:

```text
Symbol locator 31 is stale. Source changed after it was outlined. Run outline or symbols again.
```

```text
Declaration for locator 31 has not been retrieved. Call symbol with locator 31 and view="declaration" first.
```

```text
Replacement introduced 1 ERROR node near line 52. No file was changed.
```

## Deno semantic flow

For one `references` call:

1. Resolve the numeric locator to canonical path, fingerprint, and name range.
2. Verify the current file fingerprint through `tau-ast`.
3. Discover the nearest Deno workspace root.
4. Start or reuse that root's `deno lsp` process.
5. Send `initialize`, `initialized`, and current workspace settings on first use.
6. Open the target document with current source and a tracked version.
7. Send `textDocument/references` at the identifier position.
8. Convert returned UTF-16 locations to byte ranges using current source snapshots.
9. Send those locations to `tau-ast` for usage classification and enclosing-scope extraction.
10. Allocate numeric locators for returned editable scopes.
11. Render deterministic path-and-range output.

For dependency provenance, use `textDocument/definition` on imported bindings and re-exported names. Keep the original module specifier beside the resolved canonical path. If Deno reports no definition because a dependency is uncached, preserve the specifier and attach the diagnostic.

On a mutation event, close or forget affected open documents. Reopen from disk on the next semantic request. Session reload and shutdown terminate every Deno process idempotently.

LSP failure must not corrupt Rust locator state. A crashed Deno process invalidates semantic session state for its workspace and restarts lazily. It does not invalidate syntax locators unless source changed.

## Agent guidance

Update the registered tool guidance to enforce a narrow sequence:

1. Use `symbols` when the path is unknown.
2. Use `outline(names: ...)` when the path is known.
3. Use `symbol(view="signature")` to inspect a contract.
4. Use `references` before changing an exported or reused declaration.
5. Retrieve every implementation or editable scope with `symbol(view="declaration")` before replacement.
6. Use `replace_symbol` only for one complete body or declaration.
7. Refresh locators after any mutation to the same file.
8. Fall back to `read` and `patch` when work crosses unsupported syntax or requires import and placement edits.

Do not claim that the tools prove type correctness. Deno references provide semantic identity. Tree-sitter provides edit boundaries. Neither replaces `deno check` or project tests.

## TUI contract

Use the existing Pi-style one-line call component and `Text` result component. Every custom row remains bounded by `truncateToWidth()`. Expanded results render the same bounded model text with `toolOutput` coloring.

### Call rows

```text
outline → src/dashboard/service.ts [names=refreshDashboard]
symbols → . [exact function refreshDashboard public limit=20]
symbol → service.ts: refreshDashboard [declaration]
references → service.ts: refreshDashboard [limit=100]
replace_symbol → service.ts: refreshDashboard [body]
```

Narrow widths shorten the path and then options. They never remove the tool name or replace the target with an unlabelled numeric ID.

### Collapsed results

```text
1 declaration, 312 B returned, 4.5 KB avoided (<expand key> to expand)
3 symbols in 3 files (<expand key> to expand)
4 exact references, 2 tests, 3 editable scopes (<expand key> to expand)
updated 1 body, 1.4 KB replaced (<expand key> to expand)
```

`<expand key>` is rendered with `keyHint("app.tools.expand", "to expand")`; it is not hardcoded.

### Expanded results

Expanded rows show the exact model output examples from the tool sections. Replacement output adds a compact changed-range summary. Errors stay expanded automatically and use the error color for the first line.

### Registration shape

The implementation should remain ordinary Pi tools with explicit render callbacks:

```ts
const references = defineTool<typeof referencesParams, ReferencesDetails>({
 name: "references",
 label: "references",
 description:
  "Find Deno-resolved direct references to one TypeScript declaration and return enclosing editable scope locators.",
 promptSnippet: "Find direct TypeScript references and editable caller or test scopes",
 parameters: referencesParams,
 async execute(_toolCallId, params, signal, _onUpdate, ctx) {
  return executeReferences(params, signal, ctx);
 },
 renderCall(args, theme, context) {
  rowState.watch(context.toolCallId, context.invalidate);
  return renderReferencesCall(args, theme, context, rowState, locators);
 },
 renderResult(result, options, theme, context) {
  rowState.watch(context.toolCallId, context.invalidate);
  return renderReferencesResult(result, options.expanded, theme, context);
 },
});

const replaceSymbol = defineTool<typeof replaceSymbolParams, ReplaceSymbolDetails>({
 name: "replace_symbol",
 label: "replace_symbol",
 description:
  "Replace one previously retrieved TypeScript declaration or body after fingerprint and parser checks.",
 promptSnippet: "Replace one stale-safe TypeScript declaration or body",
 parameters: replaceSymbolParams,
 executionMode: "sequential",
 async execute(toolCallId, params, signal, _onUpdate, ctx) {
  return withFileMutationQueue(resolveLocatorPath(params.locator), async () =>
   executeSymbolReplacement(toolCallId, params, signal, ctx),
  );
 },
 renderCall(args, theme, context) {
  rowState.watch(context.toolCallId, context.invalidate);
  return renderReplaceSymbolCall(args, theme, context, rowState, locators);
 },
 renderResult(result, options, theme, context) {
  rowState.watch(context.toolCallId, context.invalidate);
  return renderReplaceSymbolResult(result, options.expanded, theme, context);
 },
});
```

The names above are the proposed public names. Approval Gate 1 locks them before implementation.

## Protocol changes

Bump the framed worker protocol from version 2 to version 3. There is no compatibility bridge because the TypeScript wrapper and packaged worker ship together.

Add operations for:

- enhanced `outline` results;
- repository `symbols` discovery;
- selective `symbol` views;
- locator validation without source return;
- classification and enclosing-scope mapping for LSP reference locations; and
- `replaceSymbol`.

Keep Deno LSP messages out of the Tau worker protocol. The TypeScript wrapper converts LSP locations into Tau source locations before asking Rust to classify them.

Typed worker errors add:

- `unsupported_symbol_view`;
- `no_symbol_body`;
- `uncertain_declaration`;
- `replacement_not_retrieved`;
- `replacement_parse_failed`;
- `semantic_workspace_not_found`;
- `semantic_dependency_unavailable`; and
- `deno_unavailable`.

Existing stale, invalid-locator, protocol, cancellation, and size errors remain.

## Mutation and invalidation

Generalize `TauAgentEvents["tau:file-mutation.applied"].source` from the literal `"patch"` to `"patch" | "replace_symbol"`.

`replace_symbol` emits one completed `update` change with line additions and removals. It throws before writing on every validation failure, so there is no partial result in this first operation.

The existing Explore listener invalidates all numeric locators for the path. Extend the same listener to invalidate Deno document state. Read snapshots are content-hash keyed and remain safe; changed source cannot reuse the old hash. No new cache layer is needed.

## Implementation slices and approval gates

Each slice must leave the repository green and the new behavior reachable. No fallow files or speculative interfaces.

### Gate 1: approve public contract and runtime dependency

Approve:

- public names `symbols`, `references`, and `replace_symbol`;
- required `symbol.view`;
- TypeScript and TSX scope only;
- `deno` from `PATH` for semantic operations; and
- no automatic dependency fetching.

No code starts before this gate.

### Slice 1: complete declarations and selective retrieval

Change:

- `packages/agent/native/tau-ast/src/outline.rs`
- a focused TypeScript adapter module under `packages/agent/native/tau-ast/src/`
- `packages/agent/native/tau-ast/src/protocol.rs`
- `packages/agent/native/tau-ast/src/main.rs`
- `packages/agent/extensions/explore/ast-worker.ts`
- `packages/agent/extensions/explore/ast-tools.ts`
- native and TypeScript fixtures and tests

Deliver:

- complete TypeScript declarations;
- locator version 2;
- declaration certainty;
- signature, declaration, and declaration-with-imports views;
- source-order TypeScript outline rendering; and
- required-view read tracking.

Exit check: the large-declaration trial retrieves a multiline contract and then the complete contiguous declaration, with no whole-file source returned to the model.

### Gate 2: approve declaration UX

Review golden model output and collapsed and expanded TUI rows for a real Deno package. Confirm complete signatures are useful and bounded before repository scanning is added.

### Slice 2: repository symbol discovery

Add the `symbols` worker operation and Pi tool. Add `ignore` and parallel walking dependencies only in the Rust worker. Cache parsed declarations in memory with fingerprint validation and bounded eviction.

Exit check: exact, prefix, and fuzzy queries find private and public declarations across a real repository with deterministic limits, and names-filtered output omits empty files.

### Gate 3: approve Deno semantic process

Review:

- executable discovery and missing-Deno error;
- workspace-root ownership;
- no-fetch integration evidence;
- process memory and warm latency; and
- behavior with uncached imports.

Do not add references if the language server fetches dependencies without an explicit cache request.

### Slice 3: provenance, export paths, and references

Add:

- `packages/agent/extensions/explore/deno-semantic.ts`
- Deno process ownership in `packages/agent/extensions/explore/index.ts`
- `references` schemas, execution, and rendering in `ast-tools.ts`
- native reference classification and scope mapping
- Deno workspace fixtures and integration tests

Deliver direct references, required-import provenance, `mod.ts` export paths, source classification, and enclosing editable scope locators.

Exit check: the acceptance fixture returns the production caller and both `Deno.test` scopes with exact locators. An uncached remote import causes zero HTTP requests.

### Gate 4: approve mutation

Review replacement syntax, read-before-write enforcement, parser rejection, file permission preservation, mutation event details, and stale behavior. Confirm one exact replacement is enough before adding any other edit operation.

### Slice 4: stale-safe replacement

Add `replaceSymbol` to protocol and worker, register `replace_symbol`, use `withFileMutationQueue()`, emit the generalized mutation event, and invalidate Rust and Deno state.

Exit check: stale, unread, uncertain, malformed, aborted, and successful replacements all leave the file in the expected state. Failed replacements leave bytes and permissions unchanged.

### Slice 5: agent acceptance and user docs

Run the full acceptance workflow in a fresh agent session. Record tool calls and returned bytes. Update:

- `packages/agent/extensions/explore/README.md`;
- `packages/agent/extensions/tau-help/help.md`; and
- tool descriptions and prompt guidance.

Exit check: implementation and direct test change complete without textual search or source reads, then normal project checks pass.

## Testing plan

### Rust fixtures

Add TypeScript and TSX fixtures covering:

- multiline generics and constraints;
- overload sets and merged declarations;
- decorators and attached JSDoc;
- classes with constructor, method, accessor, property, and callback members;
- complete interfaces and type aliases;
- local exports, aliases, named re-exports, and star re-exports;
- object methods and assigned arrow callbacks;
- `Deno.test`, `describe`, `it`, and labelled callbacks;
- parser recovery inside and adjacent to declarations;
- UTF-8 names and strings;
- CRLF source; and
- body replacement for block and expression bodies.

Assert exact source ranges rather than substring presence alone.

### Worker protocol

Extend `packages/agent/native/tau-ast/tests/worker.rs` for protocol 3 and every new operation. Cover partial frames, maximum frames, stale locators, duplicate locators, unknown views, uncertain replacements, parse rejection, and clean shutdown.

### Pi tools

Extend `packages/agent/test/extensions/explore/ast-tools.test.ts` for:

- required schemas and provider-safe enums;
- numeric IDs shared across outline, symbols, and reference scopes;
- selective source formatting;
- read-before-replace tracking;
- compact and expanded rows at narrow widths;
- errors staying visible when collapsed;
- mutation invalidation; and
- Deno process shutdown.

### Deno integration

Create a temporary Deno workspace with:

- `deno.json` import aliases;
- a source declaration;
- a chained `mod.ts` re-export;
- production callers;
- direct Deno tests;
- a generated reference;
- an uncached remote import served by a request-counting local server; and
- multibyte text before reference columns.

Assert exact definitions, references, provenance paths, UTF-16 conversion, source classes, editable scopes, and zero cache-trigger requests.

### Replacement safety

Cover:

- replacement without prior retrieval;
- stale source before queue entry;
- source changed while waiting in the queue;
- missing body;
- uncertain parser range;
- invalid UTF-8 boundary;
- newly introduced parse errors;
- cancellation before write;
- file mode preservation;
- mutation event payload;
- old locators rejected after success; and
- unrelated-file locators still valid.

### Acceptance evidence

Keep a compact transcript or test fixture that records:

- tool names in order;
- locators used;
- files and bytes returned to the model;
- absence of `grep`, `read`, `bash`, and `patch`; and
- successful project test output after both replacements.

## Performance limits

Measure rather than guess final thresholds. The initial targets are:

- warm syntax outline and symbol retrieval stay within the current baseline range;
- warm exact repository symbol lookup under 100 ms for a 10,000-file TypeScript tree after in-memory indexing;
- first Deno semantic response reports startup time separately;
- warm direct references under 500 ms for the acceptance repository;
- every public result remains below 50 KB and 2,000 lines; and
- resident caches expose counts and bytes in test diagnostics.

Wall-clock targets belong in benchmark reports, not normal unit-test assertions.

## Risks and stop conditions

### Deno can fetch unexpectedly

Stop at Gate 3 if normal LSP reference or definition requests contact uncached remote modules. Do not hide the behavior behind a warning. The approved policy forbids surprise network work.

### Scope mapping can choose an unsafe parent

A callback inside a large object or nested call can have several plausible parents. The Rust adapter must choose the smallest contiguous executable scope with stable ownership. If ownership is ambiguous, return the reference without a scope locator.

### Signature synthesis can look editable

Mark assembled signatures as views, not source blocks. Do not issue replacement ranges for non-contiguous output.

### Parser recovery can produce plausible ranges

Uncertain declarations remain readable and non-editable. New replacement operations should not grow a force flag.

### Deno process cost can dominate

Measure startup and memory before keeping several workspace servers alive. Initial ownership is one server per active root per session with idle shutdown available only if measurements require it.

### Public tool count can confuse agents

The tools have distinct jobs and strict schemas. If acceptance runs repeatedly choose the wrong tool, revise descriptions before adding aliases or one large action tool.

## Approval checklist

- [ ] Gate 1: tool contracts, required `symbol.view`, TypeScript scope, and Deno runtime policy.
- [ ] Gate 2: complete declaration and selective retrieval UX.
- [ ] Gate 3: Deno process, no-fetch evidence, provenance, and references.
- [ ] Gate 4: one stale-safe replacement operation.
- [ ] Final: acceptance transcript and user documentation.

Implementation starts only after Gate 1 is checked.
