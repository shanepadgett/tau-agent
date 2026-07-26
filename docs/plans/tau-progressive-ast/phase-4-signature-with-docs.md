# Phase 4: Documented Signature Retrieval

Status: implementation unapproved  
Depends on: stable outline locators and existing symbol views  
Produces: `signatureWithDocs`

## Current state

`outline(includeDocs: true)` can include attached documentation, but routine outlines omit docs to stay compact. The existing `symbol(signature)` view returns the stored declaration signature without an implementation body. An agent that later needs one contract must currently repeat the outline with docs or retrieve the complete declaration.

The worker already preserves exact source ranges, source fingerprints, declaration identity, and adapter-extracted documentation. Existing symbol views are:

- `signature`: complete declaration signature without implementation;
- `declaration`: exact complete declaration source; and
- `declarationWithImports`: exact declaration plus only required imports.

Batched retrieval merges overlapping ranges and rejects stale input atomically.

## Contract

Add `signatureWithDocs` to `SymbolView`.

It must:

- accept the same numeric locators as `signature`;
- resolve the same fingerprinted native declaration identity;
- validate every locator before returning any mixed batch;
- return attached documentation comments and contract annotations plus the complete signature;
- omit the implementation body;
- preserve exact source formatting when the adapter can identify one contiguous or safely composed source range;
- work regardless of the original outline's `includeDocs` value; and
- use the existing bounded batched symbol rendering and overlap behavior.

Attributes, decorators, modifiers, and annotations that affect declaration semantics remain part of ordinary signatures. This view adds attached explanatory documentation; it does not redefine the signature model.

When an adapter cannot associate nearby documentation confidently, return the signature with an explicit diagnostic. Never capture an unrelated preceding comment by proximity alone.

## Implementation

1. Extend the TypeScript tool schema and native protocol enum.
2. Resolve documentation from the cached or reparsed declaration at retrieval time instead of relying on what the original outline rendered.
3. Teach each language adapter to return the precise attached-documentation range already represented by its grammar and declaration rules.
4. Compose documentation and signature without including the body or unrelated imports.
5. Preserve atomic stale-locator validation for batches.
6. Keep output accounting and truncation consistent with other symbol views.
7. Update tool descriptions and user documentation to distinguish all four views.

Markdown uses the adapter's existing section or heading declaration model. Do not invent code-style doc association where the adapter has no such concept.

## Likely files

- `packages/agent/extensions/explore/ast-tools.ts`
- native protocol and symbol retrieval modules
- each supported language adapter
- TypeScript tool tests
- native adapter fixtures and worker tests
- Explore and Tau help documentation

## Validation

- A default outline without docs can be followed by `signatureWithDocs` for one locator.
- TypeScript JSDoc and deprecation text appear without a function body.
- Every supported language has a positive attached-documentation fixture.
- Documentation association is tested against unrelated nearby comments.
- Recoverable cases where an adapter cannot attach a nearby comment confidently return the signature and an explicit diagnostic.
- A stale locator makes a mixed batch fail before any source is returned.
- `signature`, `signatureWithDocs`, `declaration`, and `declarationWithImports` remain observably distinct.
- Multiline signatures, generics, overloads, attributes, decorators, and source formatting remain complete.

## Completion

Phase 4 is complete when an agent can retrieve one declaration's documented contract from an existing locator without re-outlining the file or receiving its implementation body.
