# Troubleshooting

**Logs**: `~/.tau/logs/`, one JSON-lines file per process, kept 14 days. Find a session's logs with `rg -l <session-id> ~/.tau/logs`. `logLevel` keeps more.

**Status strip** (above the input): current problems, such as failed new code or a skipped skill. Each stays until fixed. The log has the detail.

**Restart into new code**: `/restart` restarts the chat on the same session and unsent input, once no run is going. Run from source (`mise run dev`), Tau watches `src/` and restarts itself; `"autoRestart": false` leaves it to `/restart`. New code that fails to build or start leaves the old code running. After a crash Tau restarts the chat; new code that crashes twice within 10 seconds is replaced by the code before it. A crash loses unsent input. A released binary does not rebuild itself.

**Known gaps**: an expired login shows only as the failed run's reason.
