# Quick worktree command

## Agreed behavior

- `/wt` creates immediately from current `HEAD`, generates a source-branch/timestamp/unique name, copies unfinished work and dependencies, and continues the chat in a separate session.
- Open a named cmux tab by default; otherwise switch here. Keep Ghostty/manual-terminal opening in the list.
- `/wt list` retains browsing, main/session switching, details, individual removal, and missing-registration cleanup.
- `/wt clean` previews unused, clean Tau worktrees and removes approved folders after one confirmation. Keep branches and chats; preserve identity, occupancy, Git-lock, dirty-file, ignored-file, and confirmation-change guards.
- Remove `/worktree` and `setupCommand`. No subagent integration.

## Boundaries

- `index.ts`: command dispatch, existing session lifecycle tracking, terminal launch/session replacement, and shared single/batch removal flow.
- `workspaces.ts`: quick repository lookup without inspecting other worktrees on creation; Git registration without checkout; filesystem copy excluding root `.git`; independent staging-index and split-index copies; generated names; discovery and removal evidence. Refuse nested Git metadata and destinations inside the source. Report incomplete copies without opening them.
- `sessions.ts`: reuse selected-branch serialization and saved-session association. New tabs get separate session files; occupied targets never share active session files.
- `panel.ts`: retain workspace/session picker; creation no longer needs a picker action.
- Update README, Tau help, extension context, and settings/schema references.

## Cache and verification

Naming uses no model call. UI notices add no model-visible messages or tool-schema fields. Continued conversations keep the original serialized history; the new session's cwd scopes the destination system prompt and tool execution through Pi's existing session replacement/launch path. Do not insert per-worktree notes ahead of stable history.

Use disposable repositories for focused checks of copied edits, staging, dependencies, source preservation, linked-worktree creation, symlinks, split indexes, and guarded cleanup. Do not add or modify tests. Inspect command dispatch and terminal/session paths with injected runtime boundaries. Run repository checks after all work. Live extension validation requires `/reload`.

Verified with disposable repositories: partial staging, unstaged edits, staged renames, tracked deletions, intent-to-add, ignored dependencies/configuration, symlinks, unchanged source/index, independent copied files, split indexes, linked-worktree sources, sparse checkouts, detached and unborn HEAD, absent indexes, cancellation before registration, nested-Git refusal, canonical destination checks, and concurrent staging-change detection. Removal checks covered occupancy exclusion, ignored-file changes during confirmation, and retained branches.

Injected command/runtime checks covered command replacement and completions, prompt-free creation, cmux creation/send/title, outside-cmux switching, separate JSONL sessions with identical continued model-visible history, main-session resumption, one cleanup confirmation, cancellation, changed ignored files, retained conversations, and occupied/locked/external/current exclusions. No repository tests were added or changed.
