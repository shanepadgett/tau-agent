# Phase 5: Repository API Discovery

Status: implementation unapproved  
Depends on: recursive traversal, stale-safe locators, and `signatureWithDocs`  
Produces: repository-wide declaration and import-path discovery

## Current state

`outline(names: ...)` is useful after an agent knows a likely file or package. It cannot answer repository-level reuse questions such as finding a public color interpolation utility, exported declarations containing `cursor`, or an interface with an uncertain name.

Structural code-pattern search does not solve this problem. API discovery searches declaration identity, visibility, exports, re-exports, and supported import paths. `ast_search` searches source shape.

The worker already has language adapters, declaration kinds, visibility, documentation metadata, imports, exports, exact paths, fingerprints, and process-resident parse state. Recursive traversal from Phase 2 supplies ignore-aware repository scanning and bounded overflow behavior.

No persistent index is required for the first implementation. Repository research showed that native parsing, process memory, exact-name prefilters, and bounded traversal are enough to establish the contract before accepting cache invalidation and schema costs.

## Decision required before coding

Choose a tool name and strict schema that clearly communicates declaration or API discovery and remains separate from `ast_search`.

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

## Completion

Phase 5 is complete when an agent can start from reuse intent, discover a public declaration and supported import path, inspect its documented signature, and use it without reading candidate implementation files.
