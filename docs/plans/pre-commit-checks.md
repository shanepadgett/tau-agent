# Pre-commit checks for `/commit`

Status: implemented, awaiting manual testing after `/reload`.

## Goal

`/commit` can split changes into several commits, so Git `pre-commit` hooks run the same checks once per commit. Tau runs registered checks once, before plan generation:

- No registered check: no extra work, no extra UI.
- Any check fails: no plan model call, the panel closes, the failure goes to the agent and starts a turn.
- All checks pass: the flow continues unchanged.

## Decisions

1. Failure starts an agent turn (`triggerTurn: true`).
2. Git hooks are left alone; `/commit` does not pass `--no-verify`.
3. `beforeCommit` commands always run. They have no glob fields.
4. `beforeCommit` is a separate list from `afterRun`.

## Systems

| System | Change |
| --- | --- |
| Tau public events (`shared/events.ts`, `docs/extending-tau-agent.md`) | Adds `tau:commit.before`. |
| Commit extension (`commit/pre-commit-checks.ts`, `index.ts`, `review-ui.ts`) | Emits the event, waits for registered checks, gates plan generation, sends the bounded failure message. |
| Silent command runner | Adds `beforeCommit` settings and a `tau:commit.before` listener. |

## Event contract

```ts
"tau:commit.before": {
  cwd: string;
  signal: AbortSignal;
  waitFor(source: string, check: Promise<{ passed: boolean; text: string }>): void; // before first await
};
```

A rejected promise is a failure whose text is the error message.

## Commit flow

```text
loadChangeSet, assertCommittableState
worktreeSignature = computeWorktreeSignature(files)     // moved before checks and plan generation
runPreCommitChecks(pi, ctx, store, signal, git, root, { files, signature })
  emit tau:commit.before; none registered -> true
  allSettled; abort -> throw; worktree changed -> throw
  failures -> bounded tail text -> notify + sendMessage(triggerTurn) -> false
false -> close panel / return
generatePlan ...
```

The panel shows a cancellable "Running pre-commit checks" phase. Plan regeneration does not rerun checks.

## Known limit

The silent command runner selects `beforeCommit` from settings loaded at session start or the last prompt, because `waitFor` must be called before any `await`.
