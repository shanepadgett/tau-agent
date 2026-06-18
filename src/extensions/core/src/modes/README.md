# Modes

Switch Tau between small workflow modes.

## Usage

```text
/mode
/mode plan
/mode act
/mode review
/mode debug
/plan [prompt]
/act [prompt]
/review [prompt]
/debug-issue [prompt]
/audit [focus]
/debt [focus]
```

Shortcut: `Ctrl+Shift+M` cycles modes. New sessions default to `act`.

Mode shortcut commands switch mode. With trailing text, Tau switches first and submits that text in the new mode.

`/audit` and `/debt` are one-shot prompts. They borrow review posture for that turn but do not persist it.

## Behavior

- Uses the first available preferred model for the mode, with per-model thinking level.
- Keeps current model if no preferred model can be selected.
- If a provider returns `402`, `403`, `429`, or `5xx`, falls through to the next preferred model for the next turn.
- Appends short posture guidance to the system prompt.
- Shows current mode in the footer.
- Persists selected mode in the session.
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

## Modes

- `plan`: read-only exploration and numbered plans.
- `act`: focused implementation.
- `review`: complexity/stability findings unless edits are requested; covers deletion, shrink, dedupe, stdlib/native/internal reuse, YAGNI, and small stabilizing refactors.
- `debug`: reproduce, isolate, smallest causal fix; simplify the failing path when directly related.

## One-shot commands

- `/audit [focus]`: repo-wide complexity/stability audit, ranked biggest simplification first.
- `/debt [focus]`: harvest `lean:` and legacy `ponytail:` shortcut markers into a report.

## Limits

- No config-driven modes.
- No CLI flag.
- No shared event.
- No bash allowlist in plan mode; plan excludes `bash` instead.
