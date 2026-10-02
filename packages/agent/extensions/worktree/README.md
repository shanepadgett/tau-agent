# Worktree

Work on independent features in separate folders and Git branches without disturbing unfinished work. Each workspace has its own Pi conversation. Use a second terminal when you want two agents working at once.

## Commands

- `/worktree`: browse workspaces, open their sessions, show details or a terminal command, and review removal. Choose **new** to create a workspace.
- `/worktree new [name]`: choose a starting branch, a fresh or continued chat, and whether to switch here or open in another terminal.
- `/worktree open <name>`: resume a workspace's saved chat.
- `/worktree remove <name>`: review and remove a workspace Tau created. Its branch and saved conversations remain.

New workspaces use `feature/<name>` branches and live under `~/worktrees/`, outside the repository. They include committed files from the selected starting point, not unfinished edits. Install dependencies and configure local environment files in each new folder as needed.

Tau also lists worktrees created outside Tau. It can open them but does not remove them. A workspace in use by another Tau instance cannot be opened for competing edits or removed.

Removal requires committed or relocated tracked and untracked changes. The confirmation warns about ignored local files that will be deleted and commits preserved only by the retained branch. There is no automatic deletion, branch deletion, or automatic merging. Use `/commit` and your normal pull-request workflow from the feature workspace.
