# Checks in codemode

## Boundaries

Expand Silent Command Runner's existing check tool; no new settings or executor. Set configured `run_checks` exposure to `direct`, which Pi declares to the model and makes callable from scripts. Keep sequential execution and bounded results.

Call path: `await tools.patch(...)` → nested write advances verification revision while sharing the outer fixer snapshot → `text(await tools.run_checks({}))` → `tool_call` flushes the ancestor snapshot through the shared fixer queue → existing check executor → outer result flushes only later changes. Rebase the snapshot after fixes so the outer result does not repeat them. Later nested writes invalidate verification, even within the same outer call.

Extract `flushFixes(snapshot: WriteSnapshot, ctx: ExtensionContext): Promise<void>` for both boundaries. Keep snapshot lifetime owned by the outer call. Preserve existing per-command fixer failure handling and cancellation; reset rejected queue tasks so a failure does not poison later work.

Update concise tool guidance: await all writes and call checks last within codemode. Update extension docs and help. Rename repository settings' names to human-readable labels while keeping commands and descriptions separate. Remove the passed summary's trailing newline.

## Cache and verification

Only exposure and static guidance change model-facing tool definitions. Pi's codemode loadout appends script-call guidance to direct tools; unchanged configuration and revisions keep the final declarations stable. Snapshot and revision state stays out of request-prefix content. Live nested behavior and provider requests require user `/reload`; do not invoke the new nested path before that. Finish with the currently loaded `run_checks` tool. No new tests or changes to existing tests.

## Implementation status

Implemented direct/codemode exposure, shared fixer flushing and snapshot rebasing, nested write invalidation, readable names for checks and fixes, and trailing-newline removal. Source inspection confirmed the write → fix → check → outer-result path and that unchanged rebased snapshots skip duplicate fixes. `git diff --check` passed. Live codemode calls and rendering require user `/reload`.
