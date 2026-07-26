# Phase 6: Repository Structural Search

Status: implementation unapproved  
Depends on: recursive traversal, bounded overflow, and stale-safe locators  
Produces: `ast_search`

## Current state

Tau's worker uses Tree-sitter declarations behind a Tau-owned protocol and result model. Repository research selected `ast-grep-core` as the structural matching foundation because it already provides parsed code patterns, metavariables, node traversal, and replacement primitives without requiring Tau to expose or shell out to the ast-grep CLI.

This phase exposes search only. General rewriting remains outside the contract.

The relevant ast-grep performance model is:

- compile one pattern per request;
- derive literal fragments and possible node kinds;
- filter paths by language;
- scan source for required literals when available;
- parse only candidates;
- search only applicable node kinds;
- use per-thread parsers during parallel traversal; and
- stop at an explicit result limit.

Odin is not a built-in ast-grep language. Tau's statically linked Odin grammar needs an ast-grep language implementation and likely expando preprocessing because `$NAME` is not a normal Odin identifier. Pin the exact ast-grep library revision used by the worker and keep its types behind Tau's protocol.

## Tool contract

`ast_search` must:

- search one canonical repository, package, or subtree;
- accept an ast-grep code pattern with metavariables;
- infer language from a constrained target when safe;
- require a language when the pattern or target is ambiguous;
- compile the pattern once per request;
- follow Phase 2 ignore, traversal, cancellation, and overflow rules;
- stop returning matches at an explicit result limit while still reporting complete scan accounting according to the chosen traversal contract;
- expose parser and matcher uncertainty; and
- return deterministic results independent of parallel completion order.

Each match must include:

- canonical relative path and language;
- compact exact-source preview;
- byte and line range;
- useful metavariable bindings;
- follow-up locator for the exact match or retrievable source unit; and
- nearest enclosing declaration or executable scope when one exists.

Ambiguous pattern parsing must fail with a direct request for an explicit language. Invalid patterns fail before repository traversal.

## Implementation

1. Add Tau-owned request and result types to the versioned protocol.
2. Add or complete ast-grep language implementations for every supported search language.
3. Implement and fixture Odin metavariable preprocessing while preserving source ranges.
4. Reuse recursive traversal and process-resident source or parse state.
5. Add literal and potential-node-kind prefilters without changing correctness when no safe prefilter exists.
6. Register stale-safe locators before exposing numeric IDs.
7. Reuse Phase 2's bounded model output and complete temporary overflow file.
8. Report files discovered, filtered, read, parsed, and searched; matches found; matches returned; and limit status.
9. Keep configured YAML rules, rewrite templates, named fixers, and broad replacement APIs out of the public tool.

## Likely files

- native Cargo dependencies and exact lockfile pin
- native grammar registry and language implementations
- native protocol, traversal, and search modules
- `packages/agent/extensions/explore/ast-worker.ts`
- `packages/agent/extensions/explore/ast-tools.ts`
- native pattern, Odin, traversal, and cancellation tests
- Explore tool rendering and schema tests
- Explore and Tau help documentation

## Validation

- Find a repository-wide code shape without textual `grep`.
- Compile one pattern and reuse it across candidate files.
- Verify literal and node-kind prefilters do not remove valid matches.
- Verify deterministic result ordering under parallel traversal.
- Return bindings, exact ranges, previews, and retrievable locators.
- Retrieve a selected match or enclosing scope through `symbol`.
- Cancel a large scan promptly and leave the worker usable.
- Report result limits and omitted matches explicitly.
- Test Odin metavariables against current language fixtures.
- Keep structural search result types independent of ast-grep's public CLI or JSON contracts.

## Required reference validation

Before this phase is complete, run its applicable acceptance workflow against all nine read-only reference repositories and the Markdown fixture in [`language-verification-corpus.md`](./language-verification-corpus.md). Unit tests and phase-specific fixtures do not replace this pass. Treat a failure in any supported language as a phase blocker and record parser recovery or uncertainty explicitly.

## Completion

Phase 6 is complete when an agent can search unknown code shapes across a repository through one bounded, deterministic, cancellable AST operation and retrieve selected results by stale-safe locator.
