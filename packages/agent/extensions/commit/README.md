# Commit

Generate a semantic commit plan from current repository changes, review it, then create one or more commits.

## Usage

```text
/commit
```

## Overview

`/commit` looks at staged, unstaged, and untracked files, gathers bounded change evidence, and asks a model for a small set of meaningful conventional commits. You can review the plan in the TUI, edit messages, move files between commits, regenerate messages, and then commit the approved groups.

Unassigned files are left uncommitted. After successful commits, Tau asks whether to run `git push`.
