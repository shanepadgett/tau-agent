# Architecture

## Runtime and identity

- Bun only. No Node fallback. Distributed as a compiled binary (`bun build --compile`).
- Executable `tau`, global dir `~/.tau`, project dir `.tau/`. Tau never reads Pi's state.
- `@shanepadgett/tau` is the npm package and the extension import name. Inside the binary, a runtime `Bun.plugin` resolves that import to the built-in copy.

## Layers (draft)

```text
ai        providers, streaming, message format, logins, structured output, classify
core      agent loop, `run` tool, checks, change detection, process sessions, background tasks, services + events
sessions  SQLite storage, context view, branching, compaction
host      settings, auth, extension/skill/prompt loading, AGENTS.md, trust
tui       OpenTUI renderer, chat pane, sidebar, slots
cli       entry, print mode
sdk       public surface over all of the above
```

## Core ideas

- **One command and event interface.** The TUI and print mode are both clients of it, so RPC can be added later as a thin layer.
- **Services.** Every core behavior is a named service that can be wrapped or replaced, with events before and after. Examples: prompt submission, context building, model selection, tool execution, compaction.
- **Background tasks.** Core runs work beside the chat: compaction, classifier and routing calls, process sessions. Each task reports status events, which feed the sidebar. Work that changes the conversation while it is busy is applied at the next turn boundary.
- **Session data model.** Entries are never deleted. A compaction entry holds a summary and points to the first kept entry. The context the model sees is computed from entries: the latest summary, then everything from its kept entry on. Stored in SQLite (`bun:sqlite`); no Pi session import.
- **Sandbox.** QuickJS (`quickjs-wasi`) runs in a `Worker`, with its WASM embedded in the binary. Host functions are async and cancellable; a shared flag interrupts CPU-bound scripts.
- **Change detection.** Files change through scripts, `sh`, and background processes, so tool arguments cannot say what changed. Core compares the workspace before and after each `run` call (`git status` plus hashes of changed and untracked files). The result feeds `fix` checks (`{files}`) and marks `checks` results stale.
- **Background task recovery.** None for now. Work interrupted by a crash starts over on the next turn.
- **PTYs.** Bun's built-in `Bun.Terminal`, not `node-pty`; verified in compiled binaries on macOS and Linux arm64. Spawn with `detached: true`. Cancellation must cover owned descendants across shell job-control groups, then close the terminal; the spike's snapshot cleanup is not a production supervisor.

## Build order (draft)

1. AI layer, including structured output, tested with small scripts.
2. Agent loop and `run` tool, driven by print mode.
3. Sessions, background tasks, and compaction.
4. TUI and interactive shell.
5. Extension host and SDK; port Tau's built-ins from `main`.
6. Settings, packages, install, and updates.
