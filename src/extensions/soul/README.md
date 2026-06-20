# Soul

Soul is Tau's always-on Lyle prompt extension. It replaces Pi's default system prompt with Lyle's identity, project guidance, available tools, skill metadata, runtime context, and the current posture.

Disable it in Tau settings:

```json
{
  "extensions": {
    "soul": { "enabled": false }
  }
}
```

Takes effect on session start.

## Postures

Soul has four postures:

- `act`: focused implementation. Default for new sessions. Can edit the codebase and run implementation checks.
- `plan`: read-only exploration and planning. May write/edit planning notes under `docs/plans/` only. May use bash for cheap validation and programmatic assumption checks.
- `review`: read-only complexity/stability review. May write/edit review notes under `docs/plans/` only. May use bash for evidence gathering and targeted validation.
- `debug`: read-only failure isolation. May write/edit debug notes under `docs/plans/` only. May use bash for repros, targeted tests, scripts, env checks, and logs.

Commands:

```text
/posture
/posture <plan|act|review|debug>
/plan [prompt]
/act [prompt]
/review [prompt]
/debug [prompt]
/audit [focus]
/debt [focus]
```

A TUI shortcut can cycle postures. Check Pi keybindings for the current key.

In plan, review, and debug postures, writes/edits outside `docs/plans/` and clearly mutating bash commands require act posture. The agent should briefly state the plan/fix/check, wait for explicit go-ahead unless already given, then call `switch_posture` with `posture=act` before mutating. If it tries anyway, Soul can ask the user to switch to act and run the same pending tool call.

Planning note naming convention:

- `docs/plans/<slug>.md` for normal plans.
- `docs/plans/<slug>.review.md` for review notes.
- `docs/plans/<slug>.debug.md` for debug notes.

## Review helpers

`/review` can run in the current chat or a new chat. The new-chat path gathers the current diff, drafts a concise review prompt from the diff and prior chat, injects the evidence, and leaves the prompt in the input for you to edit or submit.

`/audit` runs a repo-wide avoidable-complexity audit for one turn.

`/debt` harvests `lean:` shortcut markers for one turn.

## Notes

- Keeps the selected model and active tools when switching postures.
- Shows current posture in the footer.
- Persists selected posture as `tau.posture`.
- When disabled, Soul skips prompt replacement and posture behavior.
