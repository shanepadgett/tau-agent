# Worktree

Work on independent features in separate folders and Git branches without disturbing unfinished work. Each workspace has its own Pi conversation. Use a second terminal when you want two agents working at once. In cmux the workspace opens as a new tab in your current cmux workspace; in Ghostty on macOS it opens as a new tab in the front window. Other terminals show the command to run.

## Commands

- `/worktree`: browse workspaces, open their sessions, show details or a terminal command, and review removal. Choose **new** to create a workspace.
- `/worktree new [name]`: choose a starting branch, a fresh or continued chat, and whether to switch here or open in another terminal.
- `/worktree open <name>`: resume a workspace's saved chat.
- `/worktree remove <name>`: review and remove a workspace Tau created. Its branch and saved conversations remain.
- `/worktree cleanup <name>`: review cleanup of one missing worktree registration. Its branch and saved conversations remain. You can also select a missing entry in `/worktree` and choose **Clean up missing registration**.

New workspaces use `feature/<name>` branches and live under `~/worktrees/`, outside the repository. They include committed files from the selected starting point, not unfinished edits. Set `extensions.worktree.setupCommand` in Tau settings to install dependencies in each new folder before its chat opens, for example `npm ci --ignore-scripts`. If setup fails, you can retry it, and the folder stays available through `/worktree`. Without a setup command, install dependencies and configure local environment files yourself.

Tau also lists worktrees created outside Tau. It can open them but does not delete their folders. Multiple Tau instances can use the same checkout; Tau warns because concurrent edits, automatic checks, and Git operations can interfere. Use separate worktrees for independent edits. Opening an occupied checkout through `/worktree` starts a separate chat rather than sharing its active session file. Removal and missing-registration cleanup remain blocked while another Tau instance uses the target checkout.

Missing folders and discovery errors appear in the workspace list; **Show details** explains errors. Problems with another entry do not block normal tools in your checkout. Missing-registration cleanup requires confirmation, removes only the selected registration and its Tau metadata, and works for external worktrees too. A missing folder may be on an unmounted drive: restore or mount it instead if you intend to keep that worktree. Git-locked registrations must be unlocked manually before cleanup.

Removal requires committed or relocated tracked and untracked changes. The confirmation warns about ignored local files that will be deleted and commits preserved only by the retained branch. There is no automatic deletion, branch deletion, or automatic merging. Use `/commit` and your normal pull-request workflow from the feature workspace.
