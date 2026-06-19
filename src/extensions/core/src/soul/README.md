# Soul

Always-on prompt replacement for Tau. This is Lyle: base identity plus current posture.

Soul rebuilds Pi's system prompt from `systemPromptOptions`: Lyle identity first, then Pi tool/guideline/docs sections, user prompt additions, project context, skill metadata, current posture, and runtime date/cwd last.

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

Posture shortcut commands switch posture. With trailing text, Tau switches first and submits that text in the new posture.

`/audit` and `/debt` are one-shot prompts. They borrow review posture for that turn but do not persist it.

No `/mode` command.

## Behavior

- Uses the first available preferred model for the posture, with per-model thinking level.
- Keeps current model if no preferred model can be selected.
- If a provider returns `402`, `403`, `429`, or `5xx`, falls through to the next preferred model for the next turn.
- Builds posture guidance into soul's prompt; no second prompt appender.
- Shows current posture as plain muted text in the footer.
- Persists selected posture as `tau.posture`.
- `plan` snapshots current tools and switches to read-only tools. Leaving `plan` restores the snapshot.

## Model preference

`plan`, `review`, and `debug`:

1. `openai-codex/gpt-5.5` at `xhigh`
2. `anthropic/claude-opus-4-8` at `xhigh`
3. `github-copilot/gemini-3.1-pro-preview` at `xhigh`

`act`:

1. `openai-codex/gpt-5.5` at `low`
2. `anthropic/claude-opus-4-8` at `medium`
3. `github-copilot/gemini-3.1-pro-preview` at `low`

## Posture meanings

- `plan`: read-only exploration and numbered plans.
- `act`: focused implementation.
- `review`: complexity/stability findings unless edits are requested.
- `debug`: reproduce, isolate, smallest causal fix; simplify the failing path when directly related.

## One-shot commands

- `/audit [focus]`: repo-wide complexity/stability audit, ranked biggest simplification first.
- `/debt [focus]`: harvest `lean:` and legacy `ponytail:` shortcut markers into a report.

## Limits

- No config-driven postures.
- No CLI flag.
- No shared event.
- No bash allowlist in plan posture; plan excludes `bash` instead.
