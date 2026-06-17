# commit

Generate a git commit message from current repository changes, then commit all changes.

## Usage

Run:

```text
/commit
```

## Behavior

- Waits for the active agent turn to finish.
- Reads git status, recent commit subjects, staged/unstaged diffs, and bounded snippets from untracked files.
- Calls the selected model directly so the prompt and response are not added to active chat context.
- Opens the generated commit message for review in the editor.
- Asks for confirmation.
- Runs `git add -A` and commits with the reviewed message.

## Notes

- Always commits all uncommitted changes.
- Does not create multiple commits.
- Diff and untracked file evidence is size-limited before sending to the model.
