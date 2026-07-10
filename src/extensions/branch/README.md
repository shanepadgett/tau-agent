# Branch

Fetch and switch to a recently updated Git branch, or create a typed branch
from the current `HEAD`.

Run `/branch` to fetch all configured remotes and open Pi's branch selector.
Local branches and fetched remote-only branches are ordered by their latest
commit, with the most recent first. Selecting a remote branch creates a local
branch that tracks it. Cancelling the selector changes nothing.

Run `/branch new`, choose `feature`, `fix`, or `chore`, then enter a branch
name. The name is lowercased, punctuation and whitespace become hyphens, and
leading or trailing hyphens are removed.

For example, selecting `fix` and entering `Fix login. Please` creates and
switches to `fix/fix-login-please`.

Cancelling either creation prompt creates nothing. Uncommitted changes follow
normal `git switch` behavior for both switching and creation.
