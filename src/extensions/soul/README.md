# Soul

Always-on prompt replacement for Tau. This is Lyle: base identity plus current posture.

Soul rebuilds Pi's system prompt from `systemPromptOptions`: Lyle identity first, then Pi tool/guideline/docs sections, user prompt additions, project context, skill metadata, current posture, and runtime date/cwd last.

Disable it with Tau settings:

```json
{
  "extensions": {
    "soul": { "enabled": false }
  }
}
```

Takes effect on session start. When disabled, Soul skips prompt replacement, posture switching, posture tool/thinking changes, and clears the posture footer item.

## Postures

```text
/posture
/posture plan
/posture act
/posture review
/posture debug
/plan [prompt]
/act [prompt]
/review [prompt]
/debug [prompt]
/audit [focus]
/debt [focus]
```

Shortcut: `Ctrl+Shift+M` cycles postures. New sessions default to `act`.
After `/new`, Tau asks for posture once when no posture has been selected in that session. Reload does not show the picker.

Posture shortcut commands switch posture. With trailing text, Tau switches first and submits that text in the new posture.

`/review` asks whether to review in a new chat. Choose yes and Tau stages all changes (`git add -A`), gathers the cached diff plus branch and file count, opens a fresh session with review posture restored and the diff injected as a hidden context message, and kicks off the review. `/review <prompt>` folds the prompt in as a `Focus:` line. Choose no, or run without a TUI, and `/review` keeps its current behavior: switch to review posture and optionally submit trailing text.

Staging caveat: the new-chat path runs `git add -A`, so it leaves all changes staged in the original repo. It does not modify the working tree, but it clobbers any intentional partial staging (`git reset` to undo). It does not auto-restore the prior index state.

The `switch_posture` tool lets the agent ask to change posture when the user's latest intent clearly fits another posture. Approved switches queue a hidden continuation and trigger a small follow-up turn so Soul rebuilds with the new posture guidance and tool set. Denied switches prompt for an optional reason that is returned to the agent in the tool result.

`/audit` and `/debt` are one-shot prompts. They borrow review posture for that turn but do not persist it.

No `/mode` command.

## Behavior

- Keeps the current model selected when switching postures.
- Sets thinking level by posture: `act` uses `medium`; `plan`, `review`, and `debug` use `xhigh`.
- Builds posture guidance into soul's prompt; no second prompt appender.
- Shows current posture as plain muted text in the footer when enabled.
- Persists selected posture as `tau.posture`.
- `plan` snapshots current tools and switches to read/search tools plus `write`/`edit` for `docs/plans/` only. Leaving `plan` restores the snapshot.
- Keeps `switch_posture` available in every posture so the agent can request the right posture before doing mismatched work.

## Thinking levels

Posture changes do not change the selected model.

- `plan`: `xhigh`
- `act`: `medium`
- `review`: `xhigh`
- `debug`: `xhigh`

## Posture meanings

- `plan`: read-only exploration and numbered plans; may write/edit plan files under `docs/plans/` only.
- `act`: focused implementation.
- `review`: complexity/stability findings unless edits are requested.
- `debug`: reproduce, isolate, smallest causal fix; simplify the failing path when directly related.

## One-shot commands

- `/audit [focus]`: repo-wide over-engineering/avoidable-complexity audit, ranked biggest cut first.
- `/debt [focus]`: harvest `lean:` shortcut markers into a report.

## Limits

- No config-driven postures.
- No CLI flag.
- No shared event.
- No bash allowlist in plan posture; plan excludes `bash` instead.
- Plan posture write/edit access is hard-blocked outside `docs/plans/`.
