# Commit your changes with `/commit`

`/commit` turns every changed file in the repository into one or more conventional commits. It runs the project's checks first, and commits nothing until you approve the plan.

1. In the chat, between runs, type `/commit` and press Enter. To guide the plan, add text after it, for example `/commit make this one commit`.
2. Wait while Tau runs the checks. If one fails, Tau commits nothing and sends the failures to the model, which starts fixing them. Run `/commit` again when it is done.
3. Read the plan: one line per commit, with its subject and how many files it holds.
4. Press Enter to make the commits, or Escape to cancel.
5. While Tau checks, plans, commits or pushes, the panel shows a spinner and replaces the input. When Tau asks to push, choose with Up and Down, then press Enter. Escape keeps the commits local.

## What happens

- Tau runs the `check` and `commit` lists of the project's checks file on every changed file (see [project-checks.md](project-checks.md)).
- A check that changes files, such as a formatter, stops `/commit`. Review the changes and run it again.
- The plan comes from one call to the provider's small model, such as Claude Haiku 5.5 on Anthropic, at high thinking. Set `providers.<id>.smallModel` to use another (see [settings.md](settings.md)).
- The model sees the changed files, their diff (cut at 48,000 characters), the last 12 commit subjects, your text after `/commit`, and your prompts in this session since the latest commit.
- Each commit holds only its own files. Anything you staged before is unstaged first.
- Git hooks run on each commit.
- A push goes to the branch's upstream. A branch with none pushes to `origin` and sets it as the upstream.
- Each ending leaves one line in the chat, such as "Committed 2 (a1b2c3d, e4f5a6b)." or "Commit cancelled."

## Settings

Set these in `~/.tau/settings.json`:

```json
{ "commit": { "push": "ask", "avoidBreakingChanges": false } }
```

- `push`: `"ask"` (the default) asks each time, with "No" chosen first. `true` pushes without asking. `false` never pushes.
- `avoidBreakingChanges`: `true` tells the model not to mark any commit as a breaking change. The default, `false`, marks a commit that breaks users with `!` and a `BREAKING CHANGE` footer.

## Limits

- `/commit` works only in a git repository, and only between runs.
- Escape stops the checks and the planning. Once committing starts, it runs to the end.
- If a commit fails, the line in the chat names the commits already made.
- You cannot edit the plan or its messages. Cancel and run `/commit` again with text that says what you want.
