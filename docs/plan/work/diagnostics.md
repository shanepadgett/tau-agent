# Diagnostics: logs and copying from the chat

Status: built, 2026-10-14; the live check in [live-checks.md](../live-checks.md) is open. How these logs fit with what the chat shows is in [messages.md](messages.md).

**What the user gets:** when a session goes wrong, the user gives its ID, and the agent that works on Tau reads that session's log and transcript to find the cause. In the chat, selecting text with the mouse copies it.

## What exists

- The sessions database (`~/.tau/sessions.db`) keeps the transcript. A failed run shows its error in the chat only; no entry keeps it.
- Effect logs (warnings such as a failed background note) go to `console`. In the chat, OpenTUI's console overlay captures `console`, so the user never sees them. No logger is configured: `src/cli/main.ts` uses Effect's default.
- The supervisor keeps nothing: a crash's output scrolls by in the terminal, and build and check failures show only in the notice line.
- OpenTUI captures the mouse, so the terminal cannot select text. Option-drag (iTerm2, Terminal.app) or Shift-drag (Ghostty, Kitty, WezTerm) goes around it today.

## Decisions

| Decision | Agreed | Reason |
| --- | --- | --- |
| Order | Logs, failed-run entries and copy-on-select now, before 6b | Using the dev chat to build Tau needs them |
| What is logged | Failed runs with the full Effect cause; every warning and error log; the supervisor's build and check failures, crashes (exit code and the end of the output) and fallbacks | These are what a bug report needs and what the user cannot see now |
| Format and cost | JSON Lines through `Logger.formatJson` and `Logger.toFile` (which batches and flushes when its scope closes); level `Warn` by default; a `logLevel` setting lowers it | Batching keeps file writes off the run; `rg` and `jq` read the files |
| Old logs | Deleted at startup after 14 days | No unbounded growth |
| Print mode | Keeps its stderr output and writes the log file too | `-p` output stays as it is |
| Log files | One per process, `~/.tau/logs/<yyyy-mm-ddThh-mm-ss>-<pid>.jsonl`; every line in a run is annotated with `session` | `Logger.toFile` picks its path when the process starts, before the chat has a session, and a restart moves a session to a new process; `rg -l <session-id> ~/.tau/logs` finds a session's files |
| Failed runs | Saved as a `run-failed` session entry with the text the chat showed; the next model call gets one note, "The previous run failed: …" | A resumed session shows it, and after "try again" the model knows the last run stopped part-way |
| Copying | Text stays selectable (OpenTUI's default); on mouse release the selection goes to the clipboard through `createClipboard(...).writeText`, host clipboard first, else OSC 52 | What OpenCode does; turning mouse capture off would lose wheel scrolling |
| Later | `tau debug <session>` prints the transcript and the log as one report | Not needed while the agent can read both files |

## Code plan

### 1. Log files: `src/host/LogFile.ts` (new)

`src/host` already owns files under `~/.tau` and the settings, so the logger lives there.

```ts
/** Writes this process's warnings and errors to a JSON Lines file under ~/.tau/logs, and removes old files. */
export const logFileLayer: Layer<never, never, TauHome | Settings | FileSystem>
// 1. dir = <home>/logs; makeDirectory(dir, { recursive: true })
// 2. remove files in dir whose mtime is older than 14 days (readDirectory, stat, remove); log nothing on failure
// 3. path = <dir>/<yyyy-mm-ddThh-mm-ss>-<pid>.jsonl
// 4. Logger.layer([Logger.toFile(Logger.formatJson, path)], { mergeWithExisting: true })
//    merged with Layer.succeed(References.MinimumLogLevel, settings.logLevel)
```

`mergeWithExisting` keeps the default console logger, so print mode prints as today and the chat's console output stays hidden as today. If the folder cannot be made, Tau runs without a file rather than failing to start.

`src/host/Settings.ts` gains `logLevel`: `"Debug" | "Info" | "Warn" | "Error"`, default `"Warn"`. `src/cli/main.ts` adds `logFileLayer` to `appLayer`. The supervisor and each chat child are separate processes, so each writes its own file.

### 2. What writes to the log

| Where | Log |
| --- | --- |
| `src/core/internal/runner/runner.ts`, `runEnded` failure branch | `Effect.logError("The run failed", exit.cause)` |
| `runner.ts`, around each run | `Effect.annotateLogs({ session: id })`, so every line in the run names its session |
| `src/supervisor/Supervisor.ts` | `logWarning` for a build or start-check failure (the reason), `logError` for a crash (exit code, last output) and a fallback, `logInfo` for a restart |

The warnings that exist today (`Catalog`, `skills`, `instructions`, note worker) reach the file with no change.

### 3. `run-failed` entry

```ts
// src/session/Entry.ts
const RunFailedEntry = Schema.Struct({ type: Schema.Literal("run-failed"), error: Schema.String })
```

The entry body is JSON, and old sessions have no such entry, so it needs no SQL migration; the entry-format test fixtures gain one example. `runner.ts` appends it when the run ends failed (not when cancelled). `history-events.ts` replays it as `{ type: "run-ended", reason: "failed", error }`, so a resumed chat shows the same line. `history.ts` gives the model the entry as one note: "The previous run failed: <error>".

### 4. Copy on select: `src/tui/`

`Tui.ts` makes the clipboard once with `createClipboard({ host: createHostClipboard(), terminal: createRendererClipboardAdapter(renderer) })`. `App.tsx` calls `useSelectionHandler` and, for a selection with text, calls `writeText(selection.getSelectedText(), { destination: "best-available" })`. No confirmation in this version.

### 5. Tests

- `tests/host/log-file.test.ts`: with a temporary Tau home, a warning inside `annotateLogs` reaches the file as one JSON line with its annotation; a file with an mtime older than 14 days is removed, a new one is kept.
- `tests/core/`: a model call that fails leaves a `run-failed` entry; a cancelled run does not.
- `tests/tui/chat.test.ts`: a resumed session with a `run-failed` entry shows "The run failed: …".
- Copy-on-select is checked by hand (the test terminal has no clipboard).

### 6. Docs

`docs/guide/settings.md` (`logLevel`), a "Logs" section in `docs/guide/chat.md` (where the files are, how to copy), and a row in `docs/plan/live-checks.md`.

## As built (2026-10-14)

The code follows the plan with these changes. Each has a reason.

| Change | Reason |
| --- | --- |
| The file logger replaces the console logger in every mode, so print mode writes warnings to the log file only, not stderr | In the chat the console output was hidden anyway, and `-p` output stays clean for scripts; `-p` errors that stop Tau still print through `cli/internal/failure.ts` |
| The supervisor logs a build or start-check failure as a warning and a crash or fallback as an error, through a `log` restart command; the crash line has the exit code and run time, not the end of the output, and a restart logs nothing | The child shares the terminal, so its output is not captured; a restart that works is not news |
| The clipboard is made in `App.tsx` (`copySelections`), not in `Tui.ts` | `useSelectionHandler` and the renderer are both at hand there |
| `ContextView.ts`, not `history.ts`, turns a `run-failed` entry into the note | `ContextView` builds the messages the model sees from entries |

The file logger writes in batches, so lines logged just before a hard kill can be lost.
