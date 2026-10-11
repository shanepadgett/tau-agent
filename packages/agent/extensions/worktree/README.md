# Worktree

Use `/wt` to continue your current work in a separate folder, branch, and Pi conversation without a setup interview. In cmux, it opens a named tab in your current cmux workspace. Outside cmux, it switches this terminal to the new workspace.

## Commands

- `/wt`: create a worktree from the current checkout's `HEAD`, copy unfinished edits and staging state, and continue this chat in a separate session. Branch names are generated from the source branch, timestamp, and a unique suffix, such as `wt/main-20261011-153024-a1b2c3`.
- `/wt list`: browse the main checkout and linked worktrees. Switch here, resume saved chats, open another tab, show details, or review individual removal. Externally created worktrees can be opened too. Ghostty on macOS also supports opening a new tab from the list; other terminals show a command to run.
- `/wt clean`: preview removal of unused, clean worktrees Tau created, then confirm once. Occupied, current, main, missing, Git-locked, external, dirty, and unreadable workspaces are skipped. Branches and saved conversations remain.

Workspaces live under `~/worktrees/`, outside the repository. Creation copies tracked, untracked, and ignored local files, including dependencies and environment files, while leaving the source checkout untouched. Filesystem copy-on-write is used when available; other filesystems use ordinary independent file copies. Symlinks remain symlinks and can still refer to shared external files. Copied dependencies and build outputs may need refreshing after later branch changes. Tau does not run a setup command.

Creation refuses nested Git metadata, including initialized submodules, rather than copy pointers that could affect another checkout. If copying fails or is cancelled after registration, the incomplete worktree remains registered and is not opened. Review the reported folder before using or manually removing it.

Each workspace has its own conversation. Opening a checkout already used by another Tau instance starts a separate chat rather than sharing its active session file. Concurrent edits, checks, and Git operations in the same checkout can still interfere; use separate worktrees for independent edits. Removal and missing-registration cleanup remain blocked while another Tau session uses the checkout.

Removal requires committed or relocated tracked and untracked changes. The confirmation lists deleted folders, retained branches, commits not on other branches/remotes, and ignored local files that will be deleted, including dependencies and environment files. Changes during confirmation cancel that workspace's removal. There is no branch deletion or automatic merging.

Missing folders and discovery errors appear in `/wt list`; **Show details** explains errors. Select **Clean up missing registration** to remove only that registration and its Tau metadata after confirmation, including external registrations. A missing folder may be on an unmounted drive: restore or mount it instead if you intend to keep it. Git-locked registrations must be unlocked manually before cleanup.

Session startup clears abandoned tracking and old temporary tracking files. Live processes on the current hostname remain tracked regardless of age. Session records from another hostname expire after 24 hours, so long-running sessions under an old or different hostname can stop being detected. Exclusive removal locks do not expire by age.
