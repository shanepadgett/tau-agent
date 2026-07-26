# Phase 8: Locator-Based Edits

Status: implementation unapproved  
Depends on: relationship certainty and editable-scope locators  
Produces: narrow stale-safe structural edit operations

## Current state

`symbol` can retrieve exact source from fingerprinted locators, but `patch` still requires textual context. An agent can avoid broad discovery reads and still needs source context to construct a safe edit.

Tau already has a patch implementation, a per-file mutation queue, and `tau:file-mutation.applied` events. AST state listens for changed paths and invalidates cached source and locators. New edit operations must use those mechanisms rather than writing files through a separate path.

Native locators already carry source fingerprints and exact declaration identity. Numeric locators remain model-facing session-local handles. Editing must consume opaque native identity rather than trusting a model-supplied byte range.

## Decision required before coding

Choose strict operation names and schemas for replacement, insertion, import or export updates, and rename. Prefer separate narrow operations where their validation or result contracts differ.

Do not expose general ast-grep rewriting, arbitrary syntax transforms, or compiler-grade refactoring in this phase.

## Operations

Initial support covers:

1. replace one complete declaration;
2. replace one executable body while preserving its signature, modifiers, attributes, decorators, and attached documentation;
3. insert source immediately before or after a declaration;
4. update imports and exports required by one selected declaration change; and
5. rename one declaration with explicitly bounded reference updates.

Replacement source is parsed and validated for the target language before mutation when the operation depends on a specific syntactic unit.

## Safety contract

Every operation must:

- resolve an opaque native locator from the numeric session handle;
- validate canonical path and expected source fingerprint immediately before mutation;
- reject stale, missing, or ambiguous targets before changing any file;
- preflight every affected path before a multi-file rename begins;
- use Pi's per-file mutation queue in deterministic path order;
- preserve encoding and line-ending behavior already guaranteed by patch;
- emit Tau's normal file-mutation events;
- invalidate every affected locator and orientation record;
- report all changed paths and invalidated locator IDs; and
- return a bounded verification diff or exact changed source.

Atomicity means stale or ambiguous preflight failure changes no file. Filesystem failure during a multi-file operation must be reported precisely; do not claim transactionality unless the implementation provides rollback or atomic staging.

Rename updates exact references and only those inferred references explicitly approved by the operation contract. Ambiguous references remain unchanged and are reported.

Import and export updates must use language adapter structure. They must not reconstruct a module by unconstrained string replacement.

## Implementation

1. Extend native locator identity where needed with qualified name, declaration kind, executable scope kind, and fingerprint.
2. Add native validation and edit planning that returns exact affected ranges and replacement intent without mutating files directly.
3. Apply plans through Tau's existing mutation boundary and queue.
4. Reparse or invalidate changed files after each successful mutation. Do not synthesize approximate Tree-sitter `InputEdit` values.
5. Return bounded verification output and new locators only after current source is reparsed successfully.
6. Preserve parser diagnostics when edited source remains recoverable but uncertain.
7. Keep operations unavailable for unsupported files or declaration kinds without reliable adapter support.

## Likely files

- native locator, parser, adapter, and edit-planning modules
- native protocol request and result types
- `packages/agent/extensions/explore/ast-worker.ts`
- new Explore edit tool registrations
- `packages/agent/extensions/patch/index.ts` only where a shared mutation API is required
- `packages/agent/shared/events.ts` only if existing mutation events lack required changed-path data
- stale-source, queue, mutation-event, and multi-file tests
- Explore and Tau help documentation

Do not create a second filesystem mutation implementation inside the AST worker.

## Validation

- Replace one declaration by locator without textual patch context.
- Replace a body while preserving its signature and attached metadata.
- Insert before and after a declaration at the current fingerprint.
- Update required imports and exports structurally.
- Rename exact references within an explicit bounded scope.
- Stale source stops every operation before file mutation.
- Ambiguous rename references remain unchanged and are reported.
- Concurrent writes serialize through the per-file mutation queue.
- Mutation events invalidate old locators and orientation records.
- Verification output identifies every changed path and remains within Pi limits.
- An implementation-and-test change can be discovered, retrieved, edited, and verified without textual `grep`, ranged `read`, or whole-file `read` for supported source.

## Required reference validation

Before this phase is complete, run its applicable acceptance workflow against all nine read-only reference repositories and the Markdown fixture in [`language-verification-corpus.md`](./language-verification-corpus.md). Unit tests and phase-specific fixtures do not replace this pass. Treat a failure in any supported language as a phase blocker and record parser recovery or uncertainty explicitly.

## Completion

Phase 8 is complete when Tau can safely apply the core declaration and impact-edit workflow through stale-safe structural identity while preserving its existing mutation, event, and verification guarantees.
