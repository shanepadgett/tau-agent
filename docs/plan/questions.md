# Questions

Open questions for the user. Each is removed as soon as it is answered.

## Step 6: the TUI ([work/tui.md](work/tui.md))

1. **Scope of the first cut.** Recommend 6a only (chat, input, cancel, queued prompts, resume, one status line), with the sidebar and slash commands in 6b and 6c. It is the smallest cut that lets you develop Tau from Tau.
2. **Tool settings.** May I change `tsconfig.json` (JSX), Fallow's `tui` zone (`.tsx`), oxlint (`no-effect-run` off for the adapter) and `bunfig.toml`, and add OpenTUI and Solid to `package.json` and the reference docs? Recommend yes, as the first prep step.
3. **Source or binary for 6a.** Recommend 6a runs from source (`bun src/cli/main.ts`). Developing Tau from Tau then comes from the reload slice ([reload.md](reload.md)), which runs a build of `src/` under a supervisor; the compiled binary and its PTY test come with it.
4. **Multi-line input.** Recommend Enter sends and Shift-Enter adds a line if OpenTUI's input supports it (to check in its docs); otherwise a single-line input in 6a.

## Reloading Tau while it runs ([reload.md](reload.md))

1. **Pattern.** Recommend a supervisor process that restarts Tau only when it is idle, after the new code builds and passes a start check. It beat the OpenCode split (two processes always, and core still restarts) and Vite hot swap (fragile, and core still restarts).
2. **Run builds in development.** Recommend the supervisor runs a bundle of `src/`, not the source, so a last good build exists to fall back to. Spike 15 passed: a switch takes about 0.55 s from save, with about 100 ms of empty screen.
3. **Restart trigger.** Recommend automatic when idle, with a status note before it happens, a `/restart` command, and a setting to turn the automatic restart off. Alternative: ask the user each time.
4. **Process sessions across a restart.** Recommend they end, and the checkpoint list tells the model, for now; the supervisor owning them is recorded in deferred.md. Alternative: the supervisor owns them from the start.
5. **Extension UI entry.** [sdk-packages.md](sdk-packages.md) agreed no separate UI entry, because Tau is one process. Recommend reversing that: a separate `./ui` export, so a later split of the TUI and core into two processes does not break extensions. It costs nothing now and breaks every extension later.
6. **Order.** Recommend: 6a (TUI), then the reload slice, then 6b and 6c. Until the reload slice, you develop Tau from a stable copy and restart by hand.
