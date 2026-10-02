# Worktree extension

## Approved experience

- `/worktree`: browse registered Git worktrees and choose an action.
- `/worktree new [name]`: choose a starting branch and a fresh or continued conversation, confirm the branch/base/path, then switch here or receive a command for a separate terminal.
- `/worktree open <name>`: resume that workspace's session through Pi's public session replacement API.
- `/worktree remove <name>`: inspect work at risk and confirm removal; keep its Git branch and saved conversations.
- Run the optional `extensions.worktree.setupCommand` setting inside each new worktree before opening its chat; offer retry on failure. Use ordinary feature branches, not detached HEAD.
- Apply-to-local, background orchestration, environment copying, and automatic deletion are later work, as discussed.

## Architecture

Add `packages/agent/extensions/worktree/` with these boundaries:

- `index.ts`: command dispatch, native creation/action dialogs, session lifecycle, setup command, and cross-instance ownership checks.
- `workspaces.ts`: Git discovery/creation/removal and repository-scoped metadata. Reuse `GitRunner`; discover with `git worktree list --porcelain -z` and validate canonical paths.
- `ownership.ts`: atomic workspace leases, shared by sessions and removal.
- `sessions.ts`: prepare documented JSONL session files and resume with `ctx.switchSession()`. Continued chats copy only `ctx.sessionManager.getBranch()`, not all alternative histories. Fresh chats inherit the user's current model/thinking choice without making a model request.
- `panel.ts`: compose `SelectableList` and `ToolPanel`; selecting a row opens native action dialogs.

Metadata lives under `getAgentDir()/tau/worktrees/<hash of Git common directory>/`, outside all checkouts. Each workspace has its own record and lease, avoiding shared mutable registry files. Worktree folders live under `~/worktrees/<repository-name>-<repository-id>/<feature-name>`.

Git remains authoritative for registered paths and branch names. Tau records its managed task name, creation base, and associated session path. Existing external worktrees can be opened but are not deleted by Tau.

Ownership is a per-workspace JSON file containing host, PID, and token, protected by an exclusively created short-lived claim file. A live owner prevents another Tau instance from opening or removing that workspace. Startup detects direct launches into an occupied workspace and blocks tool execution until the user switches to another workspace. Dead local owners can be reclaimed; unreadable or foreign-host ownership fails closed. A crash during a claim requires inspecting its reported path rather than racing another claimant. Shutdown releases only the current token. Removal takes the same lease as opening.

## Call paths

```text
/worktree [new|open|remove]
  -> waitForIdle -> discoverWorkspaces(GitRunner)
  -> picker / creation dialogs
  -> Git + metadata operations
  -> prepareWorkspaceSession(ctx, workspace, fresh|continue)
  -> ctx.switchSession(path, { withSession })
  -> session_start -> acquire lease -> update session association

separate terminal
  -> show shell-quoted `cd <path> && pi --session <file>`
  -> new Pi process -> same session_start/lease path
```

The starting commit is resolved and confirmed before creation. Uncommitted source changes are excluded and counted visibly. No stash, hidden commit, fetch, push, or PR operation.

Removal rejects the current checkout, external worktrees, live owners, tracked/untracked changes, and unverifiable state. Show ignored local data and commits not reachable from other branches/remotes before confirmation. Retain the feature branch; never use `git worktree remove --force` or delete branches. Recheck immediately before removal.

## Cache and recovery

Commands make no model requests and add no tools or changing system-prompt status. Footer/ownership/registry updates are outside model context. A continued session retains its original active transcript; Pi owns appended workspace/resource updates after runtime replacement. A fresh session starts a new cache history. Do not rewrite historical prompt sections or tool results to change paths.

Creation and session preparation persist before switching. Failed switching leaves the worktree and prepared chat available to reopen. Missing or identity-mismatched paths do not fall back to the local checkout. Saved sessions survive removal.

## Checks

Do not add or modify tests. Inspect the diff and exercise Git discovery, ownership, session serialization, and removal with a disposable repository using temporary resources. Existing automatic checks cover formatting, lint, types, unit tests, dead code, duplication, and Markdown. Interactive extension testing requires user `/reload`.

Completed disposable-repository checks: discovery, creation, canonical Git identity, ownership exclusion, fresh sessions, continuation of the selected conversation branch without alternative history or modified historical messages, unfinished-change refusal, ignored-file detection, retained branches and chats after removal, extension registration, competing-instance tool blocking, shutdown release, and reload/restart acquisition. Temporary repositories and session stores were removed. `git diff --check` was clean.
