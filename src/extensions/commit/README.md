# Commit

Generate a semantic commit plan from current repository changes, review it, then create one or more commits.

## Usage

```text
/commit
```

## Behavior

- Waits for the active agent turn to finish.
- Reads dirty files from the working tree: staged, unstaged, and untracked.
- Collects bounded file-level evidence and recent commit subjects.
- Includes user intent from the active conversation branch since the last successful `/commit`.
- Calls a model directly so prompts and responses stay out of active chat context.
- Generates an ordered semantic commit plan with conventional commit messages.
- Shows a review UI where you can edit messages, assign files, create groups, delete groups, reorder groups, and regenerate messages or the full plan.
- Commits each reviewed group separately by staging only that group’s files.
- Leaves unassigned files uncommitted.
- Records a hidden session marker after each successful commit so later runs ignore older user intent.
- Asks whether to push once after all commits succeed.

## Review controls

- `↑` / `↓`: move through commit groups.
- `e`: edit selected commit message.
- `a`: assign files to selected commit.
- `n`: create a new commit group from selected files.
- `r`: regenerate selected commit message.
- `R`: regenerate the whole plan.
- `[` / `]`: reorder selected commit.
- `delete`: delete selected commit group and leave its files unassigned.
- `enter`: execute the reviewed plan immediately.
- `esc`: cancel.

## Commit message rules

- Allowed types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `perf`, `ci`, `build`, `revert`.
- Optional scope must be lowercase kebab-case.
- Non-breaking commits must be a single subject line: `<type>[optional scope]: <description>`.
- Breaking commits must use `!` and exactly one body paragraph starting with `BREAKING CHANGE:`.
- Bodies are rejected for non-breaking commits.

## Limits

- Splitting is file-level only. Mixed unrelated changes inside one file cannot be split.
- The workflow owns the git index while executing commits and resets staging before each commit group.
- If the working tree changes during review, execution aborts and the plan must be regenerated.
- Unassigned files stay uncommitted and may become unstaged.
- Push uses plain `git push` and requires the branch/upstream to be configured.
- File evidence is size-limited before sending to the model.
