# Commit

Generate a git commit message from current repository changes, then commit all changes.

## Usage

Run:

```text
/commit
```

## Behavior

- Waits for the active agent turn to finish.
- Reads git status, recent commit subjects, staged/unstaged diffs, and bounded snippets from untracked files.
- Includes user intent from the active conversation branch since the last successful `/commit`.
- Calls commit models directly so the prompt and response are not added to active chat context.
- Falls back through the commit model tier list when generation fails.
- Skips remaining models from a provider when the failure looks provider/account-level, such as auth, billing, credits, quota, or rate limits.
- Cools down provider/account-level failures for one day before trying that provider again.
- Generates and validates a strict conventional commit message.
- Opens the generated commit message for review in the editor, then validates the reviewed message before committing.
- Asks for commit confirmation, then asks whether to push after commit.
- Runs `git add -A` and commits with the reviewed message.
- Records a hidden session marker after a successful commit so later `/commit` runs ignore older user intent.
- Runs `git push` if requested.

## Commit message rules

- Allowed types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `perf`, `ci`, `build`, `revert`.
- Optional scope must be lowercase kebab-case.
- Non-breaking commits must be a single subject line: `<type>[optional scope]: <description>`.
- Breaking commits must use `!` and exactly one body paragraph starting with `BREAKING CHANGE:`.
- Bodies are rejected for non-breaking commits.

## Limits

- Always commits all uncommitted changes.
- Does not create multiple commits.
- Push uses plain `git push` and requires the branch/upstream to be configured.
- Diff and untracked file evidence is size-limited before sending to the model.
- Conversation intent includes text user messages on the active pi branch since the last successful `/commit`.
