# Deterministic Context Sync

## Goal

Replace the current context-maintenance subagent workflow with one isolated, constrained model call. The parent Pi session should see only an empty trigger call and a compact result. Git evidence, catalog evidence, model reasoning, and the private planning tool call must stay outside the parent conversation.

The sync may update context membership and rescope affected entries. It must also be able to return `no-change`. Existing context mappings should not churn merely because sync ran.

## User-visible behavior

Provide two entry points backed by the same runner:

- `/context-sync`
- `context_sync` with an empty parameter object

The parent-visible tool is only a trigger. It does not accept paths, instructions, or policy options.

The parent tool result should stay small:

```json
{
  "outcome": "applied",
  "summary": "Updated 2 context entries; created 1; removed 1.",
  "changedContextFiles": [".pi/contexts/gameplay/player.toml"]
}
```

For a clean mapping:

```json
{
  "outcome": "no-change",
  "summary": "Existing context mappings already fit the changed scope.",
  "changedContextFiles": []
}
```

The collapsed tool row should show only `context_sync` plus the final summary. Expanded rendering may list entry operations and affected paths from `result.details`. Those details must not be copied into the textual tool result sent back to the parent model.

`/context-sync` should show the same status and final summary through the TUI. It takes no arguments and performs no separate review flow.

## Execution model

Do not create an `AgentSession` and do not call `runSubagent`.

Use `generateToolValidated` from `packages/agent/shared/model-fallback/index.ts`. It calls a model directly with a fresh message list and one private tool. Follow the commit planner pattern in `packages/agent/extensions/commit/commit-plan.ts`.

The private tool must be a local `Tool` value. Do not register it through `pi.registerTool`, so neither the parent session nor unrelated extensions can call it.

Suggested private tool name:

```text
submit_context_sync
```

The model must call it exactly once. `generateToolValidated` already enforces the single-call rule. Give validation at most two attempts, matching the existing helper default.

Use `resolveCandidates(ctx)` without adding context-specific settings or a new public model option. The helper's isolated request, fallback behavior, and authentication handling are sufficient.

## Evidence bundle

Build the complete model prompt before generation. The model receives no read, grep, Git, context, or mutation tools.

### Repository state

Resolve the Git root with the shared Git runner. Handle these cases before model generation:

- Outside a Git repository: return a clear no-op/error result consistent with other repository tools.
- Clean worktree: return `no-change` without calling a model.
- Unmerged files: fail before generation.

Collect staged, unstaged, renamed, deleted, copied, and untracked files with porcelain v2 `-z`. Keep paths repository-relative and sorted. Assign stable numeric IDs after sorting so the model can refer to evidence without repeating arbitrary paths where practical.

For every dirty file include:

- numeric ID
- path
- old path for rename/copy records
- status and normalized kind
- current context memberships
- old-path memberships for renames
- bounded diff or bounded untracked-file preview

Reuse the safe evidence behavior from `packages/agent/extensions/commit/git-change-set.ts`: omit deleted contents, avoid binary previews, bound each file, and process evidence with limited concurrency. Extract shared Git parsing/evidence code only if doing so leaves both callers simpler. Do not make the context implementation depend on commit-specific intent or marker handling.

### Context catalog

Load all entries with `loadContextEntries(root)`. Include a compact complete catalog containing:

- entry ID
- concept name and description
- entry description
- member paths
- missing member paths

Derive and label:

- changed files with no membership
- affected entries
- affected concepts
- renamed old paths that currently have membership
- deleted paths that currently have membership
- stale catalog paths unrelated to the current Git change set

Unrelated stale paths are evidence only. The model must not modify them during this sync because affected-scope validation will reject the operation.

### Affected scope

An existing entry is affected when it contains:

- a dirty path
- the old side of a dirty rename
- a direct local dependency candidate imported by a dirty file

When one entry is affected, include every sibling entry in the same concept as rescoping evidence. This lets the model split a broad `all` entry into narrower entries without inspecting the whole repository.

For changed files with no membership, include the complete compact catalog so the model can attach them to a suitable existing entry or propose a new entry. Do not mark every catalog entry as mutable. Mutation eligibility remains bounded by the validation rules below.

### Bounded rescoping evidence

For files already present in affected entries, include a bounded structural preview even when the file is unchanged. Prefer path, first meaningful lines, and direct local dependency references over full contents. Apply both per-file and total prompt caps.

Recommended initial limits:

- dirty diff or preview: 4,000 characters per file
- unchanged affected-entry preview: 1,500 characters per file
- total generated evidence: 64,000 characters
- untracked file preview: 12,000 bytes before character truncation

Truncate deterministically by sorted path. State omissions in the prompt. Do not silently drop the changed-file catalog or current memberships.

## Direct dependency candidates

Version one should support direct local dependency judgment without Tree-sitter.

Build a deterministic candidate list from added diff lines and current dirty-file contents:

1. Extract quoted or backtick path-like specifiers from import/include/module statements.
2. Consider only relative specifiers beginning with `./` or `../`.
3. Resolve from the importing file's directory.
4. Match an exact project file first.
5. If the specifier omits an extension, match a unique existing project file by appending a known repository extension or resolving an `index.<ext>` file.
6. Reject paths outside the repository, directories, ambiguous matches, package names, and unresolved aliases.
7. Stop after one dependency hop. Do not recursively inspect imports from candidates.

The prompt should include each resolved edge:

```text
packages/agent/extensions/foo/index.ts -> packages/agent/shared/math.ts
```

The model decides whether the dependency belongs in the affected context entry. The validator only permits dependency additions from this resolved candidate list.

Keep extraction deliberately small. Support common `import`, `export ... from`, `require`, `use`, `include`, and module statements when they contain a relative quoted path. Do not add Tree-sitter, language servers, alias configuration, or package-resolution machinery in this change.

## Private planning schema

The private tool should describe desired entry mutations, rather than a sequence of low-level add/remove calls. Desired state makes rescoping easier to validate before any write.

Use a discriminated union with these outcomes:

```ts
type ContextSyncSubmission =
 | {
   outcome: "no-change";
   reason: string;
   }
 | {
   outcome: "apply";
   reason: string;
   changes: Array<
    | {
      action: "set-entry";
      tab: string;
      concept: string;
      conceptName: string;
      conceptDescription: string;
      entry: string;
      description: string;
      files: string[];
      }
    | {
      action: "delete-entry";
      tab: string;
      concept: string;
      entry: string;
      }
   >;
   };
```

`set-entry` replaces the complete desired state for one entry. It creates the entry when absent. This supports membership updates, entry splits, and movement between concepts. `delete-entry` removes an obsolete entry after its useful files have been rehomed.

Keep `reason` required and non-empty. It is audit detail and expanded-row content. Do not send the full reason back in the parent tool's textual result.

## Model instructions

The prompt should make these rules explicit:

- Call `submit_context_sync` once and produce no prose response.
- Return `no-change` when existing mappings already support likely future work.
- Context entries are reusable work scopes, not inventories of every touched file.
- Prefer updating an existing entry over creating a near-duplicate.
- Do not create one entry per file.
- Follow direct local dependency candidates when the imported file is needed to understand or modify the affected scope.
- A shared dependency may belong to multiple entries when those entries genuinely depend on it.
- Do not add package dependencies, generated files, incidental imports, or recursively discovered dependencies.
- Reconsider granularity only inside affected concepts.
- Split a broad entry when its files now form durable, independently useful responsibilities such as `movement` and `input`.
- Preserve broad entries when narrower entries would mostly duplicate files or names without improving future work.
- New or unmapped changed files may remain unmapped when no reusable context scope is justified.
- Do not clean unrelated stale paths.
- Use only evidence and candidate paths supplied in the prompt.

Include one concrete rescoping example in the prompt: replacing `gameplay/player/all` with `gameplay/player/movement` and `gameplay/player/input`, while preserving every still-useful file from the deleted broad entry.

## Validation

Validation owns trust. Parse the private tool arguments into a normalized plan before touching disk.

### General validation

- Require a valid discriminated outcome.
- Trim and require `reason`.
- Reject `changes` on `no-change`.
- Require at least one change for `apply`.
- Validate every tab, concept, and entry with `validSlug`.
- Normalize every path with `normalizeProjectPath`.
- Sort and deduplicate file lists.
- Require every `set-entry` to have a non-empty name, description, and file list.
- Require every member path to exist as a regular file at validation time.
- Reject duplicate changes for the same entry ID.
- Reject setting and deleting the same entry.
- Reject a `set-entry` identical to current state.
- Reject an `apply` plan whose normalized final catalog equals the current catalog.

### Mutation eligibility

Allow changes only when tied to the affected scope:

- Existing affected entries may be set or deleted.
- Existing sibling entries in an affected concept may be set when needed for a split or merge.
- A new entry may be created when it contains at least one dirty file or allowed direct dependency candidate.
- A new concept may be created only when every proposed file belongs to the eligible file universe and at least one is dirty.
- Existing unrelated entries and concepts are immutable during this run.

The eligible file universe is:

- dirty files that still exist
- direct dependency candidates resolved by the collector
- existing files already belonging to affected entries or sibling entries participating in a rescope

No model-supplied path outside that universe may enter the plan.

### Rescoping safety

- `delete-entry` may target only an existing affected entry.
- Every still-existing file from a deleted entry must remain in at least one final entry in the affected concept or in another explicitly set destination entry.
- Deleted or renamed-away files need no preserved membership.
- The final catalog may not contain empty entries.
- If all entries in a concept are deleted, remove that concept TOML file.
- Existing concept metadata remains unchanged unless the concept is newly created. Reject model attempts to rename or rewrite existing concept metadata during this version.
- Preserve membership overlap when multiple contexts genuinely need the same shared dependency.

### Freshness checks

Compute two signatures before generation:

- worktree signature covering porcelain status, staged diff, unstaged diff, and bounded untracked-file identity/content
- context catalog signature covering sorted context TOML paths and their exact bytes

After generation and normalization, acquire the context sync write lock and recompute both signatures. If either changed, apply nothing and return an error telling the caller to rerun sync.

## Catalog application

Apply the normalized desired state by concept file, not by repeatedly calling the old low-level operation functions.

For each affected `.pi/contexts/<tab>/<concept>.toml` file:

1. Parse the current file while holding the sync lock.
2. Verify it still matches the catalog signature.
3. Build the complete final TOML object in memory.
4. Preserve existing concept metadata and untouched entries exactly in meaning.
5. Apply every normalized `set-entry` and `delete-entry` for that concept.
6. Serialize with `smol-toml`.

Prepare all output before replacing any file. Write temporary files beside their targets, then rename them into place in sorted path order. Snapshot original bytes first. If a rename or deletion fails, restore every path already changed and report the failure. This provides rollback for ordinary write failures; do not claim filesystem-wide atomicity across multiple TOML files.

Serialize concurrent sync attempts with a module-level promise lock. Continue using `withFileMutationQueue` for each final target path so Tau file writers do not race. Acquire target queues in sorted order to avoid deadlocks.

Delete a concept TOML file when its final object has no entries. Remove an empty tab directory afterward only when it contains no other files. Never delete `.pi/contexts` itself.

Return internal details containing:

- outcome and reason
- normalized entry changes
- changed TOML paths
- counts for created, updated, deleted, and unchanged entries

## File changes

### `packages/agent/extensions/context/index.ts`

- Keep `/context`, active selection persistence, autoread injection, `session_start`, and `before_agent_start` behavior.
- Remove `/context-manage`.
- Remove `maintain`, review locking, `context_changes`, `context_review`, and every low-level public `context_*` tool.
- Register `/context-sync` with no arguments.
- Register the empty `context_sync` trigger tool.
- Call one shared `runContextSync(pi, ctx)` implementation from both entry points.
- Require a trusted project. The command should require TUI because it uses TUI status/notifications. The tool may run in any trusted mode supported by its `ExtensionContext`.
- Pass the tool execution signal into model generation and Git execution.
- Add compact `renderCall` and `renderResult` implementations. Follow the reusable `Text` component pattern in `packages/agent/extensions/explore/ls.ts`.

### `packages/agent/extensions/context/definitions.ts`

- Keep `ContextEntry`, root discovery, path normalization, slug validation, catalog loading, and file checks used by `/context` and sync.
- Remove `ContextProposal`, `ContextOperation`, `writeContextEntry`, `updateContextFiles`, `replaceContextFile`, and `applyContextOperation` after the new catalog writer is wired.
- Add only reusable catalog types or serialization helpers that are genuinely shared by selection and sync. Keep sync-specific plan types in the sync module.

### New `packages/agent/extensions/context/sync.ts`

Own orchestration, Git evidence gathering, catalog evidence gathering, signatures, direct dependency candidate discovery, freshness checks, and final catalog application. If this file becomes difficult to navigate, split pure model schema/prompt/validation into `sync-plan.ts`; do not create more files preemptively.

Export pure helpers only when tests need them or another context module calls them.

### `packages/agent/extensions/context/panel.ts`

- Keep `ContextPanel` unchanged except for imports made dead by removal.
- Delete `ProposalReviewDecision`, `ProposalPanel`, and `operationPaths`.

### Delete `packages/agent/extensions/subagent/agents/context-maintenance.md`

Context sync no longer uses a custom child agent.

### `packages/agent/extensions/subagent/agents.ts`

Remove `context-maintenance` from packaged-agent-unavailable diagnostics. Built-ins become `scout` and `web-research`.

### Documentation

Update these user-facing files in the same change:

- `packages/agent/extensions/context/README.md`
  - document `/context-sync`
  - remove `/context-manage <idea>` and maintenance-agent language
  - explain automatic Git-based scope and valid no-change results
- `packages/agent/extensions/tau-help/help.md`
  - replace `/context-manage <idea>` with `/context-sync`
  - remove `context-maintenance` from the subagent built-in list
- `packages/agent/docs/subagents.md`
  - remove `context-maintenance` from Tau's built-ins

Do not change `packages/agent/docs/extending-tau-agent.md`; this design adds no public event.

## Tests

Keep tests focused on deterministic boundaries. Do not test model intelligence.

### Update `packages/agent/test/extensions/context/definitions.test.ts`

- Retain catalog mapping coverage.
- Remove tests for deleted low-level mutation APIs.
- Add catalog serialization/application coverage only if that logic remains in `definitions.ts`.

### Add `packages/agent/test/extensions/context/sync.test.ts`

Cover pure collectors, normalization, validation, and application:

1. Clean worktree returns `no-change` without model generation.
2. Dirty tracked, staged, untracked, deleted, and renamed files produce stable sorted IDs and memberships.
3. A rename carries old-path memberships and permits replacement with the new path.
4. A relative direct import resolves to one existing project file.
5. Extensionless imports resolve only when the result is unique.
6. Package imports, aliases, ambiguous paths, and paths outside the root produce no candidate.
7. Candidate discovery stops after one hop.
8. Unmapped changed files are reported without forcing an operation.
9. `no-change` validates with a reason.
10. Empty, duplicate, contradictory, unrelated, or identical plans fail.
11. A direct dependency candidate may be added to an affected entry.
12. An arbitrary existing project file outside the eligible universe is rejected.
13. Splitting `player/all` into `player/movement` and `player/input` validates when every surviving file is preserved.
14. Deleting a broad entry without rehoming a surviving member fails.
15. Existing concept metadata changes fail.
16. New concepts require at least one dirty file and only eligible files.
17. Multiple entries may contain the same shared dependency.
18. Final-state application updates multiple entries in one TOML file without losing untouched entries or concept metadata.
19. Removing the last entry deletes the concept file and then its empty tab directory.
20. A changed worktree signature prevents all writes.
21. A changed catalog signature prevents all writes.
22. A simulated write failure restores already replaced context files.

Mock `generateToolValidated` only in orchestration tests. Prompt tests should assert required policy phrases and evidence sections instead of snapshotting the entire prompt.

### Add tool rendering and registration coverage

Follow existing extension tool tests:

- parent-visible tool parameters are an empty object with no additional properties
- collapsed call is compact
- collapsed result contains only the summary
- expanded result shows normalized operations and paths
- the private `submit_context_sync` tool is never registered
- removed low-level tools and `context_changes`/`context_review` are absent
- `/context-sync` and `context_sync` reach the same runner

## Removal and compatibility

This is an intentional replacement. Do not retain aliases for `/context-manage`, old low-level context tools, old operation types, or the `context-maintenance` built-in agent. Project rules require no backward compatibility unless requested.

Search for the removed command, agent name, tool names, proposal panel types, and operation types after editing. Remove dead imports and stale documentation in the same change.

## Cleanup and refactoring requirements

Treat cleanup as part of the implementation, not a later pass.

- Delete replaced functions, types, schemas, prompts, panels, tests, agent definitions, and documentation. Do not leave deprecated wrappers or forwarding aliases.
- Remove imports, exports, constants, helper functions, and dependencies that become unused after the subagent and review flows disappear.
- Delete empty files and directories created by the removal. Keep a directory only when another tracked file still needs it.
- Remove stale references from tool descriptions, generated prompt text, help text, test fixtures, comments, and error messages.
- Refactor shared code when context sync and commit genuinely need the same Git evidence mechanism. Keep domain-specific policy separate; commit intent handling must not leak into context sync.
- Refactor `definitions.ts` around the remaining catalog responsibilities instead of preserving its old mutation API shape.
- Collapse single-use helpers when extraction no longer improves readability. Split `sync.ts` only when evidence collection, planning, and application cannot remain clear in one file.
- Keep all added code reachable and wired in the same change. Do not stage unused modules, exports, operation types, or renderers for hypothetical follow-up work.
- Preserve `/context` selection, session restoration, and autoread behavior exactly unless a compile-safe refactor requires moving code.
- Do not remove validation, path containment, trusted-project checks, mutation queues, freshness checks, rollback, or file-existence checks while simplifying.
- If a concept loses its final entry, remove its TOML file. If that leaves the tab directory empty, remove the tab directory. Never remove `.pi/contexts` itself.
- After implementation, search the repository for `/context-manage`, `context-maintenance`, `context_review`, `context_changes`, every removed low-level `context_*` tool name, `ProposalPanel`, `ProposalReviewDecision`, `ContextOperation`, and `ContextProposal`. Every remaining match must have a current purpose.
- Inspect the final changed-path list. Any obsolete implementation or test file left behind needs an explicit reason to remain.

## Implementation order

1. Add pure sync evidence types, Git parsing, catalog analysis, dependency candidate discovery, and signatures.
2. Add private tool schema, prompt construction, and plan normalization/validation.
3. Add final-state catalog application with locking, freshness checks, and rollback.
4. Add `runContextSync` orchestration using `generateToolValidated`.
5. Wire `/context-sync` and `context_sync`, including compact rendering.
6. Remove `/context-manage`, low-level context tools, proposal review UI, and old mutation APIs.
7. Delete the built-in context-maintenance definition and clean subagent discovery diagnostics.
8. Update context, Tau help, and subagent documentation.
9. Add and update tests.
10. Search for stale symbols and references. Leave the repository with no dead compatibility surface.

## Explicitly out of scope

- Tree-sitter integration
- recursive import graph traversal
- package or workspace dependency resolution
- TypeScript path alias resolution
- language-server integration
- automatic sync hooks after every patch or commit
- a public Tau event for context sync
- user-configurable context-sync models or policies
- parent-supplied paths, instructions, or option bags
- full-catalog cleanup unrelated to the current Git change set
