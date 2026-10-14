# Questions

Open questions for the user. Each is removed as soon as it is answered.

## Reloading Tau while it runs ([reload.md](reload.md))

1. **Pattern.** Recommend a supervisor process that restarts Tau only when it is idle, after the new code builds and passes a start check. It beat the OpenCode split (two processes always, and core still restarts) and Vite hot swap (fragile, and core still restarts).
2. **Run builds in development.** Recommend the supervisor runs a bundle of `src/`, not the source, so a last good build exists to fall back to. Spike 15 passed: a switch takes about 0.55 s from save, with about 100 ms of empty screen.
3. **Restart trigger.** Recommend automatic when idle, with a status note before it happens, a `/restart` command, and a setting to turn the automatic restart off. Alternative: ask the user each time.
4. **Process sessions across a restart.** Recommend they end, and the checkpoint list tells the model, for now; the supervisor owning them is recorded in deferred.md. Alternative: the supervisor owns them from the start.
5. **Extension UI entry.** [sdk-packages.md](sdk-packages.md) agreed no separate UI entry, because Tau is one process. Recommend reversing that: a separate `./ui` export, so a later split of the TUI and core into two processes does not break extensions. It costs nothing now and breaks every extension later.
6. **Order.** Recommend: 6a (TUI), then the reload slice, then 6b and 6c. Until the reload slice, you develop Tau from a stable copy and restart by hand.
