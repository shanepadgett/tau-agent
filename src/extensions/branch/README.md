# Branch

Create and switch to a typed Git branch from the current `HEAD`.

Run `/branch`, choose `feature`, `fix`, or `chore`, then enter a branch name.
The name is lowercased, punctuation and whitespace become hyphens, and leading
or trailing hyphens are removed.

For example, selecting `fix` and entering `Fix login. Please` creates and
switches to `fix/fix-login-please`.

Cancelling either prompt creates nothing. Uncommitted changes follow normal
`git switch -c` behavior.
