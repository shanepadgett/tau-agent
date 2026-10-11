# Silent Command Runner phases

## Agreed scope

- Replace `commands` with `afterWrite` and `afterRun`; remove both levels of `enabled`.
- Keep Markdown's `md-lint` extension separate.
- Treat outer codemode calls as one modification boundary.
- Migrate repository tasks, settings, schema, help, and references.

## Architecture and boundaries

Expand Silent Command Runner, using Pi's awaited `tool_call` and `tool_result` handlers. No new extension or public event is needed. Snapshot project-relative paths and SHA-256 content hashes for matching globs before write-capable calls. Track snapshots by call ID; ignore descendants of tracked calls. Known tools include patch, write, edit, bash, powershell, script_runner, codemode, image_gen, and screenshot_window; custom tools without an explicit read-only annotation are also eligible.

`Settings = { maxOutputBytes, afterWrite: CommandConfig[], afterRun: CommandConfig[] }`. Commands retain name, shell command, cwd, env, details, globs, and timeout. An unquoted `{files}` placeholder expands to shell positional arguments containing absolute changed paths; filenames are never interpolated into shell source. Commands without the placeholder retain project-wide behavior.

Call path: tool_call -> scan matching content -> store snapshot; tool_result -> serialized fixer queue -> scan -> compare added/changed files -> execute matching commands in configured order -> record post-fix hashes. Ignore already-fixed content when overlapping calls finish. Fixers are awaited, output and ordinary command failures are suppressed, timeouts remain enforced, and session/turn cancellation terminates processes. Failed tools still receive post-write handling for partial mutations. Deleted paths are not passed to fixers.

Existing agent_before_settle -> runChangedCommands -> collectCommandFailures -> continuation stays responsible for afterRun checks. Wait for fixer work first. Keep the existing run-wide change detector and failure baseline reset.

## Repository migration

- Add fix:lint and fix:fmt tasks accepting changed paths; run lint fixes before formatting.
- Make check:lint, check:fmt, and check:markdown read-only; retain existing automatic afterRun entries.
- Update ready's verification detection to afterRun, root README, extension README, and Tau help.
- Let schema synchronization generate tau.schema.json; do not hand-edit it.
- No test additions or edits. Reload is required before live extension testing.

## Cache and validation

Only the automatic-checks prompt text changes, through the existing append-only prompt source. File lists, hashes, and fixer output never enter model requests. Across unchanged consecutive requests the prompt and tool schemas remain unchanged; failures append messages through the existing continuation path.

Inspect installed command interfaces and resulting diffs; use existing automatic checks. Keep the persisted plan until the user confirms completion.

## Implementation status

Implemented the two settings arrays, awaited post-write fixes, codemode grouping, safe changed-file arguments, cancellation, and repository migration. Schema synchronization regenerated the schema. Mise dry-run confirmed that supplied paths, including a path containing spaces, are passed as separate formatter arguments. Live extension behavior requires user `/reload` before verification.

After user reload, simplified changed-file detection to use each snapshot entry's hash directly instead of repeated Map lookups. Wrote that change through an outer codemode call with an unreassigned `let`, missing spaces, and a missing semicolon. Reading the file after the call confirmed automatic conversion to `const` and correctly formatted multiline code. No manual fix commands or test files were used.
