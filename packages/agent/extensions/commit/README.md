# Commit

Generate a semantic commit plan from current repository changes, review it, then create one or more commits.

## Usage

```text
/commit
```

## Overview

`/commit` takes over the editor for the full run. It gathers change evidence, asks a model for a small set of meaningful conventional commits, lets you review and edit the plan, commits the approved groups, then asks whether to run `git push`.

Unassigned files are left uncommitted. Progress and prompts stay in the commit panel until the flow ends; success still uses the normal notify messages.
