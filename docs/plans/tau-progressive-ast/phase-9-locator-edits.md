# Phase 9: Locator-Based Edits

Status: implemented
Depends on: relationship certainty and editable-scope locators  
Produces: narrow stale-safe structural edit operations

## Current state

`symbol` can retrieve exact source from fingerprinted locators, but `patch` still requires textual context. An agent can avoid broad discovery reads and still needs source context to construct a safe edit.

Tau already has a patch implementation, a per-file mutation queue, and `tau:file-mutation.applied` events. AST state listens for changed paths and invalidates cached source and locators. New edit operations must use those mechanisms rather than writing files through a separate path.

Native locators already carry source fingerprints and exact declaration identity. Numeric locators remain model-facing session-local handles. Editing must consume opaque native identity rather than trusting a model-supplied byte range.

## Recorded decisions

1. The initial public tools are `replace_declaration`, `replace_body`, `insert_declaration`, and `rename_declaration`. Keep them separate because they validate different syntactic units and produce different impact reports.
2. The public schemas are:
   - `replace_declaration(locator, source)`;
   - `replace_body(locator, body)`;
   - `insert_declaration(locator, position: "before" | "after", source)`; and
   - `rename_declaration(locator, newName, scope, includeInferred)`, where `scope` is either `{ kind: "file" }` or `{ kind: "repository", path }`.
3. `includeInferred` is required. Exact references are eligible in either mode. Inferred references are eligible only when it is `true`. Ambiguous references are never eligible.
4. `Relationship.actionable` does not authorize a rename. It only excludes ambiguous resolution. The rename planner must inspect relationship certainty directly.
5. Native code plans edits and returns expected fingerprints, exact ranges, replacement text, and skipped impacts. It does not write files.
6. Locator edits use one shared mutation executor extracted from the patch mutation boundary. The executor acquires Pi's per-file queues, revalidates fingerprints while holding those queues, commits staged writes, and reports the same change records used by patch.
7. `tau:file-mutation.applied.source` gains `"locatorEdit"`. Existing listeners continue to own locator, structural-attempt, and cached-read invalidation.

Do not expose general ast-grep rewriting, arbitrary syntax transforms, or compiler-grade refactoring in this phase. Structural module edits are specified separately in [`../deferred/tau-ast-structural-import-export-edits.md`](../deferred/tau-ast-structural-import-export-edits.md).

## Operations

Initial support covers:

1. replace one complete declaration;
2. replace one executable body while preserving its signature, modifiers, attributes, decorators, and attached documentation;
3. insert one declaration immediately before or after another declaration; and
4. rename one declaration with explicitly bounded reference updates.

`replace_declaration.source` must parse as exactly one declaration valid in the target's current parent container. For a Markdown heading locator, it replaces the complete section and must contain one root heading at the selected depth; deeper child headings are allowed. `replace_body.body` must replace exactly the adapter-provided `body_range`; block delimiters belong to code bodies when the range includes them. For Markdown, it preserves the selected heading and replaces its section content, which may contain only deeper headings. `insert_declaration.source` must parse as exactly one declaration valid in the selected declaration's parent container. The planner validates each operation by applying it to the retained source in memory and reparsing the affected file before returning a mutation plan.

Markdown insertion and rename remain unavailable. Heading hierarchy changes outside complete section replacement still use `patch`.

## Safety contract

Every operation must:

- resolve an opaque native locator from the numeric session handle;
- validate canonical path and expected source fingerprint immediately before mutation;
- reject `Match` locators, stale or missing targets, and declarations with recovered or near-recovery certainty before changing any file;
- require a declaration locator for replacement, insertion, and rename, and require a reliable non-empty `body_range` for body replacement;
- preflight every affected path before a multi-file rename begins;
- use Pi's per-file mutation queue in deterministic path order;
- preserve encoding and line-ending behavior already guaranteed by patch;
- emit Tau's normal file-mutation events;
- invalidate every affected locator and stale structural-attempt record;
- report all changed paths and invalidated locator IDs; and
- return a bounded verification diff or exact changed source.

Atomicity means stale or ambiguous preflight failure changes no file. Filesystem failure during a multi-file operation must be reported precisely; do not claim transactionality unless the implementation provides rollback or atomic staging.

Rename validates `newName` as one identifier for the target language before planning. It updates the declaration name and exact references within the requested scope. It updates inferred references only when `includeInferred` is `true`. Ambiguous references remain unchanged and are reported with their candidate locators. A repository rename must fail preflight when traversal limits, omitted competing candidates, unreadable files, or changed fingerprints make its claimed scope incomplete.

## Implementation

1. Add native validation and edit planning that decodes opaque locators, checks locator kind and parse certainty, validates operation-specific syntax, and returns exact affected ranges, replacement text, expected fingerprints, and skipped impacts.
2. Keep numeric locator lookup and stale-session checks in Explore. The native request receives only the opaque locator token and operation input.
3. Extract a shared exact-source mutation executor from patch. It accepts canonical paths, expected fingerprints, and complete replacement sources; acquires all affected queues in sorted path order; re-reads and validates every source; then commits staged writes.
4. Apply native plans only through that shared mutation executor. Do not route locator ranges through patch's textual chunk matcher.
5. Emit the normal mutation event after each successful committed change. Return the numeric locator IDs invalidated by those events, not opaque tokens.
6. Reparse changed files after mutation. Do not synthesize approximate Tree-sitter `InputEdit` values.
7. Return bounded verification output and fresh numeric locators only after current source reparses successfully. If reparsing is recoverable but uncertain, preserve diagnostics and withhold fresh editable locators for uncertain declarations.
8. Keep operations unavailable for unsupported files, unsupported Markdown operations, recovered targets, and declaration kinds without reliable adapter support.

## Likely files

- native locator, parser, adapter, and edit-planning modules
- native protocol request and result types
- `packages/agent/extensions/explore/ast-worker.ts`
- new Explore edit tool registrations
- `packages/agent/extensions/patch/executor.ts` for the shared queued exact-source mutation API
- `packages/agent/extensions/patch/index.ts` where patch adopts the shared mutation API
- `packages/agent/shared/events.ts` to add the locator-edit event source
- stale-source, queue, mutation-event, and multi-file tests
- Explore and Tau help documentation

Do not create a second filesystem mutation implementation inside the AST worker.

## Validation

- Replace one declaration by locator without textual patch context.
- Replace a body while preserving its signature and attached metadata.
- Insert before and after a declaration at the current fingerprint.
- Rename exact references within file and repository scopes.
- Rename inferred references only with explicit approval.
- Stale source stops every operation before file mutation.
- Match locators, recovered targets, unsupported body shapes, and invalid replacement units fail before file mutation.
- Ambiguous rename references remain unchanged and are reported.
- Incomplete repository traversal stops rename before file mutation.
- Concurrent writes serialize through the per-file mutation queue.
- Mutation events invalidate old locators and structural-attempt records.
- Verification output identifies every changed path and remains within Pi limits.
- An implementation-and-test change can be discovered, retrieved, edited, and verified without textual `grep`, ranged `read`, or whole-file `read` for supported source.

## Required reference validation

Before this phase is complete, run its applicable acceptance workflow against all nine reference repositories and the Markdown fixture in [`language-verification-corpus.md`](./language-verification-corpus.md). Unit tests and phase-specific fixtures do not replace this pass. Treat a failure in any supported language as a phase blocker and record parser recovery or uncertainty explicitly.

Validation completed against the full code corpus with live edits followed by `git reset --hard HEAD`. `insert_declaration`, `replace_body`, `replace_declaration`, and `rename_declaration` succeeded for certain declarations in TypeScript, TSX, Rust, C#, Go, Java, Odin, Kotlin, and Swift. The selected Java `checkArgument(boolean expression)` and Swift `RigidArray` recovery cases rejected all four operations before mutation. Every reference repository was clean after restoration. Markdown section and body replacement have native acceptance coverage; insertion and rename remain rejected.

## Completion

Phase 9 is complete when Tau can safely replace declarations and bodies, insert declarations, and perform bounded renames through stale-safe structural identity while preserving its existing mutation, event, and verification guarantees.
