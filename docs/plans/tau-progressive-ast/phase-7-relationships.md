# Phase 7: Relationships and Editable Scopes

Status: complete
Depends on: API discovery, structural search, and addressable declarations
Produces: references, callers, tests, and nearest editable-scope locators

## Current state

Tau has syntactic declaration identity and exact source retrieval. It does not yet resolve references, callers, implementations, or affected tests. A reference line alone is insufficient for editing because `symbol` needs an addressable enclosing declaration or executable region.

Tree-sitter cannot provide compiler-grade resolution for aliases, overloads, inferred types, dynamic dispatch, or runtime registration. Repository research found a practical approximation: combine same-file bindings, imports and exports, a repository symbol table, and dependency closure, then label every relationship as exact, inferred, or ambiguous.

This phase begins in process memory. A persistent graph would add versioning, grammar invalidation, locking, crash-safe writes, repository-move handling, and compaction before measured reuse justifies those costs.

## Recorded decisions

1. Public tools are `references`, `callers`, `callees`, `implementations`, and `tests`. Each requires a repository path, one numeric declaration locator, and a bounded result limit.
2. TypeScript against the `pi` reference repository is the first exact cross-file resolver. Other adapters use conservative syntactic inference and preserve ambiguity.
3. Dedicated callback locators cover parser-identified closures, lambdas, anonymous functions, and procedure literals. Standard test file conventions and attached test annotations classify tests; arbitrary callback names do not.

Do not combine all relationship operations into an untyped action bag.

## Executable scope model

Before returning edit-oriented relationships, every supported language must expose locators for its reliable executable scopes:

- functions and methods;
- constructors, accessors, and initializers;
- standard test declarations and test containers;
- labelled callbacks and framework handler members when extraction is reliable; and
- top-level executable regions where the language permits them.

Each scope needs canonical path, language, kind, qualified identity, exact source range, body range when applicable, and source fingerprint. Synthetic scopes must remain deterministic and must not hide parser uncertainty.

## Relationship contract

Initial operations cover:

- references and type usages;
- direct callers and callees;
- implementations and overrides;
- re-exports that affect public reachability; and
- tests that directly reference the declaration or its owning public behavior.

Each result reports:

- reference path and exact location;
- relationship kind;
- exact, inferred, or ambiguous certainty;
- production, test, generated, or re-export classification;
- selected target declaration locator; and
- nearest safe editable enclosing-scope locator.

Ambiguous relationships may be displayed but must not silently enter an edit set. Generated code must be classified before later edit tooling can select it.

## Implementation

1. Add executable-scope extraction and fixtures to each language adapter.
2. Build an in-memory request or process-scoped symbol and module table from existing declaration, import, export, and re-export data.
3. Resolve exact syntactic references first, then bounded language-specific inference.
4. Preserve competing candidates when resolution is ambiguous.
5. Reuse recursive traversal, cancellation, deterministic ordering, output limits, overflow files, fingerprints, and numeric locator registration.
6. Classify tests from language and repository file conventions. Do not add a setting or guess from arbitrary callback names.
7. Let every result flow into `symbol` for exact enclosing-scope retrieval.
8. Give selected members, callbacks, tests, and executable regions their own locators instead of exposing unchecked arbitrary source ranges.
9. Keep compiler services, full type checking, dynamic call-graph claims, persistent graph storage, and budget-ranked context packs out of scope.

## Likely files

- canonical native declaration and locator model
- language adapters and fixtures
- native protocol and relationship modules
- repository module/export resolution from Phase 5
- `packages/agent/extensions/explore/ast-tools.ts`
- worker and tool tests for relationships, certainty, and scopes
- Explore and Tau help documentation

## Validation

- Every supported language can retrieve its standard executable and test scopes by locator.
- A declaration locator finds direct callers and directly affected tests.
- Results distinguish exact, inferred, and ambiguous relationships.
- Results distinguish production, test, generated, and re-export locations.
- Every editable relationship includes the nearest safe enclosing-scope locator.
- Same-name declarations and ambiguous dispatch do not silently resolve to one target.
- Deno-style re-exports and package surfaces preserve public reachability.
- Large scans are bounded, deterministic, and cancellable.
- An agent can retrieve the complete implementation and affected test scopes without textual `grep`, ranged `read`, or whole-file `read`.

## Required reference validation

Before this phase is complete, run its applicable acceptance workflow against all nine read-only reference repositories and the Markdown fixture in [`language-verification-corpus.md`](./language-verification-corpus.md). Unit tests and phase-specific fixtures do not replace this pass. Treat a failure in any supported language as a phase blocker and record parser recovery or uncertainty explicitly.

Acceptance passed against the required TypeScript, TSX, Rust, C#, Go, Java, Odin, Kotlin, Swift, and Markdown targets. Every selected declaration produced a fresh locator and completed its applicable relationship scans without traversal limits or diagnostics. Non-empty results returned editable-scope locators that resolved through `symbol(declaration)`. The code-language probes also preserved documented signatures, plain signatures, attributes and modifiers, and exact declarations. The corpus produced exact, inferred, and ambiguous relationships plus production and test classifications; ambiguous results remained non-actionable. The known Java parser recovery on `Preconditions.checkArgument` remained explicit and its locator still resolved.

## Completion

Phase 7 is complete when a selected declaration can expand into trustworthy direct impact information and every actionable result has a stale-safe locator for the complete scope that must be inspected or edited.
