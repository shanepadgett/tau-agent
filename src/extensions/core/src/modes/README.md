# Modes

Switch Tau between small workflow modes.

## Usage

```text
/mode
/mode plan
/mode act
/mode review
/mode debug
```

Shortcut: `Ctrl+Shift+M` cycles modes. New sessions default to `act`.

## Behavior

- Uses the first available preferred model for the mode, with per-model thinking level.
- Keeps current model if no preferred model can be selected.
- If a provider returns `402`, `403`, `429`, or `5xx`, falls through to the next preferred model for the next turn.
- Appends short mode guidance to the system prompt.
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
- `review`: findings only unless edits are requested.
- `debug`: reproduce, isolate, then fix.

## Limits

- No config-driven modes.
- No CLI flag.
- No shared event.
- No bash allowlist in plan mode; plan excludes `bash` instead.
