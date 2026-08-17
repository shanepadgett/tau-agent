# Branch

Switch to a recently updated Git branch, or create a typed branch from the
current `HEAD`.

Run `/branch` to open a picker containing local branches and already-fetched
remote branches. The picker shows up to 10 branches at once, ordered by their
latest commit with the most recent first.

Press `Ctrl+F` in the picker to fetch all configured remotes and refresh the
open list. Selecting a remote branch creates a local branch that tracks it.
Cancelling the picker does not switch branches.

After you pick a branch, Tau asks you to confirm. On confirm it switches, then
runs `git clean -fd` so untracked files and folders left from other branches
are removed. Ignored files such as `.env` stay.

Run `/branch new`, choose `feature`, `fix`, or `chore`, then enter a branch
name. The name is lowercased, punctuation and whitespace become hyphens, and
leading or trailing hyphens are removed.

For example, selecting `fix` and entering `Fix login. Please` creates and
switches to `fix/fix-login-please`.

Cancelling either creation prompt creates nothing. Uncommitted tracked changes
follow normal `git switch` behavior for both switching and creation.
