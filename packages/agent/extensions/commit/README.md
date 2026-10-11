# Commit

Generate a semantic commit plan from current repository changes, review it, then create one or more commits.

## Usage

```text
/commit
```

## Overview

`/commit` takes over the editor for the full run. It gathers change evidence, asks a model for a small set of meaningful conventional commits covering every dirty file, lets you review and edit the commit messages, commits the approved groups, then optionally pushes.

Grouping is fixed: files cannot be moved between commits in the review UI. If the grouping is wrong, regenerate the plan with a note describing what to change. Message editing and per-message regeneration stay available.

Set `extensions.commit.push` to push automatically after the commits land. When it is false, `/commit` stops after committing and leaves pushing to you.

If the current branch has no upstream, pushing runs `git push --set-upstream origin <branch>` to establish tracking. Branches with an upstream use normal `git push` behavior.

Progress and prompts stay in the commit panel until the flow ends; success still uses the normal notify messages.
