# Commit

Generate a semantic commit plan from current repository changes, review it, then create one or more commits.

## Usage

```text
/commit
```

## Overview

`/commit` takes over the editor for the full run. It gathers change evidence, asks a model for a small set of meaningful conventional commits covering every dirty file, lets you review and edit the commit messages, commits the approved groups, then optionally pushes.

Before generating the plan, `/commit` runs pre-commit checks once if any extension registered them, for example Silent Command Runner's `beforeCommit` commands. If a check fails, `/commit` stops without committing and sends the failures to the agent to fix. Without registered checks, this step is skipped.

Grouping is fixed: files cannot be moved between commits in the review UI. If the grouping is wrong, regenerate the plan with a note describing what to change. Message editing and per-message regeneration stay available.

`extensions.commit.push` controls what happens after the commits land:

- `"ask"` (default): ask whether to push, with “No” selected by default. Decline or dismiss the question to keep the commits local.
- `true`: push automatically without asking.
- `false`: keep the commits local without offering to push.

Without an interactive UI, only `true` pushes; `"ask"` and `false` stop after committing.

If the current branch has no upstream, pushing runs `git push --set-upstream origin <branch>` to establish tracking. Branches with an upstream use normal `git push` behavior.

Progress and prompts stay in the commit panel until the flow ends; success still uses the normal notify messages.
