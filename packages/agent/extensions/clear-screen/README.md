# Clear Screen

Clears the terminal viewport and scrollback when Pi starts, then clears again when Pi quits.

It does **not** clear on `/reload`, `/resume`, `/new`, or `/fork`, so Pi hot reloads and session switches keep the current TUI flow intact.

## Behavior

- Runs only when `process.stdout` is a TTY.
- Clears once per process on startup. Reloads do not re-clear.
- Clears on process exit only when the final `session_shutdown` reason is `"quit"`.
- Uses ANSI clear sequences (`\x1b[2J\x1b[3J`) on Unix and modern Windows consoles.
- Falls back to a newline-fill on older Windows consoles that do not support the scrollback escape.

## Limits

- TTY-only. Pipe, socket, and script runs are a no-op.
- Old Windows consoles get a best-effort visible clear, not a guaranteed scrollback clear.
- Process-level state is keyed on a `globalThis` symbol so reloads reuse a single startup clear and a single exit hook.

## Usage

Load extension, then reload Pi:

```text
/reload
```

The package manifest glob `./extensions/*/index.ts` auto-loads this extension.
