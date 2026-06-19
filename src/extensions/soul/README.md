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

- `act`: focused implementation. Default for new sessions.
- `plan`: read-only exploration and planning. May write/edit plan files under `docs/plans/` only.
- `review`: complexity/stability review unless edits are requested.
- `debug`: reproduce, isolate, and fix failures.

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

Shortcut: `Ctrl+Shift+M` cycles postures.

In plan posture, implementation writes/edits outside `docs/plans/` require switching to act first. The agent should briefly state the plan, wait for explicit go-ahead unless already given, then call `switch_posture` with `posture=act` before using write/edit tools.

## Review helpers

`/review` can run in the current chat or a new chat. The new-chat path gathers the current diff and opens review posture with that evidence injected. It may stage changes to build the diff, so avoid it if you need to preserve partial staging.

`/audit` runs a repo-wide avoidable-complexity audit for one turn.

`/debt` harvests `lean:` shortcut markers for one turn.

## Notes

- Keeps the selected model when switching postures.
- Shows current posture in the footer.
- Persists selected posture as `tau.posture`.
- When disabled, Soul skips prompt replacement and posture behavior.
