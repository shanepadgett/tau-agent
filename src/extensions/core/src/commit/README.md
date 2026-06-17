# Commit

Generate a git commit message from the current repository changes, then commit everything.

## Usage

```text
/commit
```

## Behavior

- Waits for the active agent turn to finish.
- Stages all changes with `git add -A`, then reads recent commit subjects and a single `git diff --cached` (tracked edits and new files alike) as evidence.
- Includes user intent from the active conversation branch since the last successful `/commit`.
- Calls a model directly so the prompt and response stay out of the active chat context.
- Tries a short list of preferred cheap models, then falls back to the active session model. Missing or unauthenticated preferred models are skipped; the session model is the guaranteed fallback.
- If one model fails, tries the next; if all fail, reports each error.
- Generates and validates a strict conventional commit message.
- Opens the message in the editor for review, then validates the reviewed message.
- Asks for commit confirmation, then asks whether to push.
- Commits the staged changes with the reviewed message.
- Records a hidden session marker after a successful commit so later runs ignore older user intent.
- Runs `git push` if requested.

## Commit message rules

- Allowed types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `perf`, `ci`, `build`, `revert`.
- Optional scope must be lowercase kebab-case.
- Non-breaking commits must be a single subject line: `<type>[optional scope]: <description>`.
- Breaking commits must use `!` and exactly one body paragraph starting with `BREAKING CHANGE:`.
- Bodies are rejected for non-breaking commits.

## Limits

- Always commits all changes; does not create multiple commits.
- Stages all changes before generating the message. On cancel, changes remain staged (revert with `git reset`).
- Push uses plain `git push` and requires the branch/upstream to be configured.
- Diff evidence is size-limited before sending to the model.
