# Phase 5: Repository API Discovery

Status: complete
Depends on: recursive traversal, stale-safe locators, and `signatureWithDocs`  
Produces: repository-wide declaration and import-path discovery

## Current state

`outline(names: ...)` is useful after an agent knows a likely file or package. It cannot answer repository-level reuse questions such as finding a public color interpolation utility, exported declarations containing `cursor`, or an interface with an uncertain name.

Structural code-pattern search does not solve this problem. API discovery searches declaration identity, visibility, exports, re-exports, and supported import paths. `ast_search` searches source shape.

The worker already has language adapters, declaration kinds, visibility, documentation metadata, imports, exports, exact paths, fingerprints, and process-resident parse state. Recursive traversal from Phase 2 supplies ignore-aware repository scanning and bounded overflow behavior.

No persistent index is required for the first implementation. Repository research showed that native parsing, process memory, exact-name prefilters, and bounded traversal are enough to establish the contract before accepting cache invalidation and schema costs.

## Decision

The tool is `api_discover`. Its query schema remains separate from structural source search.

Do not build one action option bag combining declaration discovery and structural patterns.

## Query contract

Support one bounded query within a repository, package, or subtree:

- exact declaration name;
- name prefix;
- name substring;
- bounded deterministic fuzzy name;
- declaration kind;
- public, private, source-file export, or package-surface filtering; and
- optional documentation-backed lexical terms for uncertain concepts.

Exact, prefix, substring, and kind queries must work without a persistent index. Fuzzy and concept matching must have explicit candidate and work limits. Embeddings and semantic vector search remain out of scope.

## Candidate contract

Return deterministic candidates without implementation bodies. Each candidate must include:

- declaration name and kind;
- compact signature or contract preview;
- defining file;
- visibility;
- source-file export status;
- package or module public-surface status;
- internal-only status when applicable;
- re-export chain when applicable;
- supported import path and import form for callers;
- parse or resolution uncertainty; and
- numeric locator backed by a fingerprinted native locator.

Distinguish the defining file from the module path consumers should import. Resolve chained re-exports. Deno-style `mod.ts` files are a required TypeScript fixture for the broader package-surface problem.

Tree-sitter syntax alone cannot prove every dynamic export, alias, inferred type, or runtime module path. Report exact, inferred, or ambiguous provenance rather than presenting an approximation as certain.

## Implementation

1. Reuse Phase 2 traversal, ignore rules, cancellation, deterministic ordering, and overflow handling.
2. Build declaration candidate filtering over adapter output and warm process state.
3. Resolve source exports, re-exports, and package surfaces through language-specific module rules.
4. Add import-path selection separately from declaration location.
5. Register candidate locators through the existing session-local numeric map.
6. Let selected candidates flow directly into `symbol(signatureWithDocs)`.
7. Report files scanned, declarations considered, results returned, result limit, and omitted candidate count.
8. Add no persistent cache, embeddings, or compiler-grade type service in this phase.

## Likely files

- `packages/agent/extensions/explore/ast-tools.ts`
- `packages/agent/extensions/explore/ast-worker.ts`
- native protocol and repository traversal modules
- language adapters for exports, re-exports, and import forms
- TypeScript package-surface fixtures, including Deno `mod.ts`
- native worker and Explore tool tests
- Explore and Tau help documentation

## Validation

- Find an exact exported declaration without knowing its path.
- Find bounded candidates by prefix, substring, fuzzy name, and kind.
- Constrain every query to a canonical repository, package, or subtree.
- Distinguish source export, package public surface, internal export, and re-export.
- Return the supported caller import path rather than only the defining file.
- Follow chained re-exports and expose uncertainty where resolution is incomplete.
- Retrieve a selected candidate's documented contract through its locator without reading its implementation.
- Report scan and result limits without hiding omitted candidates.

## Required reference validation

Before this phase is complete, run its applicable acceptance workflow against all nine read-only reference repositories and the Markdown fixture in [`language-verification-corpus.md`](./language-verification-corpus.md). Unit tests and phase-specific fixtures do not replace this pass. Treat a failure in any supported language as a phase blocker and record parser recovery or uncertainty explicitly.

## Implementation record

The worker resolves TypeScript package metadata and re-export chains plus Cargo modules, Go module/package paths, Java and Kotlin packages, C# namespaces, Swift package targets, and inferred Odin repository-relative imports. Results use one language-neutral `callerAccess` object with `modulePath`, `importStatement`, `accessExpression`, and direct-or-qualified `form`. Visibility distinguishes public, protected, internal, package-private, file-private, private, and unknown access. Resolution keeps exact, inferred, ambiguous, and unsupported provenance without choosing a silent nearest path.

Protocol 9 carries this contract. No persistent index was added.

Native protocol acceptance passed against the required TypeScript, TSX, Rust, C#, Go, Java, Odin, Kotlin, Swift, and Markdown corpus declarations. Every locator returned its expected documented signature without an implementation body. Rust's `parse_sql` correctly remains an ambiguous package-surface result because `ast-bro` keeps `adapters` private. Odin and Swift caller access remains explicitly inferred.

Live protocol-9 acceptance after reload passed exact package-surface discovery and `symbol(signatureWithDocs)` for all corpus declarations. TypeScript and TSX returned their package names, C#/Go/Java/Kotlin returned exact namespace or package access, Swift returned its inferred SwiftPM target, and Odin returned `base/runtime` when scoped to the repository. The Rust corpus declaration remained correctly absent from `packageSurface`; a root-level `ast_bro::run` probe verified supported Rust caller access. Prefix, substring, bounded fuzzy, declaration-kind, and documentation queries passed against the TypeScript package fixture. Avalonia passed without traversal limits when scoped to `src/Avalonia.Base`; the Odin repository-wide probe found the target but reached the elapsed traversal budget, while the `base/runtime` package scope completed without limits.

Final live checks covered every restricted visibility class: TypeScript protected, Rust/C#/Kotlin/Swift internal, Java package-private, Odin file-private, and ordinary Go private declarations. The `private` surface returned each one with `packageSurface=no` and `internalOnly=yes`. Markdown headings now report `sourceExport=no` and `packageSurface=no`.

Exact, prefix, substring, and declaration-kind discovery now filters declarations before signature finalization, locator encoding, and caller-surface resolution. Odin, Go, and Swift also skip parsing files that cannot contain the requested exact, prefix, or substring name. Other adapters retain parsing because they can synthesize or normalize declaration names. TypeScript keeps its complete import and re-export graph. Rust resolves module parents lazily, caches repeated module checks, and counts surface resolution against the traversal elapsed budget.

The release worker's repository-wide Odin `copy_slice` probe fell from 25.2 seconds with an elapsed-limit result to 0.48 seconds with all 1,862 supported files scanned, one declaration considered, and no traversal limit. A direct protocol-9 pass then completed every required exact-name corpus probe and `signatureWithDocs` lookup without an elapsed limit. Individual discovery calls ranged from 0.004 seconds for Markdown to 3.43 seconds for Guava.

## Completion

Phase 5 is complete when an agent can start from reuse intent, discover a public declaration and supported import path, inspect its documented signature, and use it without reading candidate implementation files.
