# Deferred: Structural Import and Export Edits

Status: deferred and unapproved  
Depends on: Phase 9 locator-based edits and the shared queued mutation executor

## Goal

Add stale-safe, language-aware operations that update imports and exports required by a selected declaration change. Plans must come from adapter structure and apply through Tau's normal mutation boundary.

This work must support adding, removing, merging, and aliasing module declarations without reconstructing a module through unconstrained string replacement.

## Current boundary

The existing `matching_*_imports` functions support `symbol(declarationWithImports)`. They inspect a declaration, identify names it appears to use, and return existing import text for retrieval. They do not provide a mutation model.

Safe mutation needs more information than those selectors currently retain:

- the imported or exported symbol, local binding, module source, and import form;
- grouped, multiline, wildcard, namespace, default, static, type-only, and side-effect forms;
- aliases and duplicate bindings;
- comments, attributes, directives, and intentional grouping;
- local exports, re-exports, package surfaces, and language-specific visibility rules; and
- the exact structural range that can change without disturbing adjacent module declarations.

Each adapter has different syntax and merge rules. TypeScript and TSX alone include default, namespace, named, type-only, side-effect, local export, and re-export forms. Go, Rust, C#, Java, Kotlin, Swift, and Odin have their own grouped, aliased, wildcard, static, attributed, or scoped forms. A shared string-edit algorithm cannot preserve all of them safely.

## Decision required before coding

Choose narrow public operation names and schemas after adapter mutation capabilities are mapped. Decide whether callers request one explicit import or export change, or provide a selected declaration change whose required module impact is planned natively.

Do not add a general module-rewrite action bag. Import and export validation and result contracts may justify separate tools.

## Safety contract

Every operation must:

- resolve opaque native declaration identity from a numeric session locator;
- validate canonical paths and expected source fingerprints while holding Pi's per-file mutation queues;
- reject stale, recovered, near-recovery, unsupported, or ambiguous module structures before mutation;
- parse and validate requested bindings, aliases, and module sources for the target language;
- use adapter-owned import and export nodes, ranges, and merge rules;
- preserve comments, attributes, directives, line endings, and unaffected grouping;
- detect existing equivalent bindings and avoid duplicates;
- preflight every affected path before a multi-file export or re-export update;
- report unresolved, conflicting, and intentionally unchanged module declarations;
- apply complete planned sources through the shared queued mutation executor;
- emit Tau's normal file-mutation events; and
- return bounded verification output and fresh locators only after successful reparse.

Stale or ambiguous preflight failure changes no file. Filesystem failure must be reported precisely; do not claim transactional rollback unless the mutation executor provides it.

## Adapter work

1. Define a canonical import and export model that preserves each adapter's original syntax and source ranges.
2. Record local binding, imported name, exported name, module source, import or export form, and relevant metadata without flattening language-specific distinctions.
3. Add adapter planners for insertion, removal, merge, split, alias, local export, and re-export operations only where the grammar provides reliable structure.
4. Keep unsupported forms unchanged and report them instead of falling back to textual replacement.
5. Reparse each planned source and confirm the requested binding graph before returning a mutation plan.
6. Reuse Phase 9 fingerprint validation, deterministic path ordering, mutation events, invalidation, verification output, and fresh-locator registration.

Do not require all adapters to share one source-rendering algorithm. Share the mutation result shape and safety boundary; keep syntax decisions in the adapters.

## Likely files

- native import, export, discovery, and language-adapter modules
- native protocol request and result types
- `packages/agent/extensions/explore/ast-worker.ts`
- new Explore structural module-edit tool registrations
- the shared queued mutation executor introduced by Phase 9
- mutation-event, stale-source, adapter, and multi-file tests
- Explore and Tau help documentation

## Validation

- Add a missing import without duplicating an equivalent binding.
- Merge into a compatible grouped import while preserving aliases and comments.
- Keep incompatible forms separate when merging would change semantics.
- Remove one binding without deleting unrelated bindings or side-effect imports.
- Add and remove local exports and re-exports through adapter structure.
- Preserve wildcard, namespace, static, type-only, attributed, and language-specific forms.
- Reject invalid aliases, module sources, recovered syntax, and stale fingerprints before mutation.
- Stop multi-file re-export updates when preflight cannot prove the complete impact set.
- Serialize concurrent writes through the shared per-file mutation queues.
- Emit normal mutation events and invalidate old locators and structural-attempt records.
- Keep verification output within Pi limits and provide fresh locators only after successful reparse.
- Run applicable acceptance against every code-language repository in [`../tau-progressive-ast/language-verification-corpus.md`](../tau-progressive-ast/language-verification-corpus.md). Markdown must remain explicitly unsupported unless a later scope adds link or heading mutation.

## Completion

This work is complete when supported adapters can make requested import and export changes through structural identity, preserve unaffected module syntax, reject uncertain cases before mutation, and use the same queue, event, invalidation, and verification guarantees as other locator edits.
