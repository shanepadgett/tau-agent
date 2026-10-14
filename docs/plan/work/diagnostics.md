# Diagnostics: session logs and copying from the chat

Status: proposed, not agreed. Comes before or with slice 6b, because using the dev chat to build Tau needs both.

**What the user gets:** when a session goes wrong, the user gives its ID, and the agent that works on Tau reads that session's log and transcript to find the cause. In the chat, selecting text with the mouse copies it.

## What exists

- The sessions database (`~/.tau/sessions.db`) keeps the transcript. A failed run shows its error in the chat only; no entry keeps it.
- Effect logs (warnings such as a failed background note) go to `console`. In the chat, OpenTUI's console overlay captures `console`, so the user never sees them.
- The supervisor keeps nothing: a crash's output scrolls by in the terminal, and build and check failures show only in the notice line.
- OpenTUI captures the mouse, so the terminal cannot select text. Option-drag (iTerm2, Terminal.app) or Shift-drag (Ghostty, Kitty, WezTerm) goes around it today.

## Proposed decisions

| Decision | Proposal | Reason |
| --- | --- | --- |
| Where logs go | One JSON Lines file per session, `~/.tau/logs/<session-id>.jsonl`, and `~/.tau/logs/supervisor-<date>.jsonl` for what happens before a session exists | `rg` and `jq` read them; the database stays for the transcript |
| What is logged | Failed runs with the full Effect cause and the provider's request ID; every warning and error log; the supervisor's builds, check failures, crashes (exit code and the end of the output), restarts and fallbacks | These are what a bug report needs and what the user cannot see now |
| How it stays cheap | `Logger.formatJson` with `Logger.toFile`, inside `Logger.batched`; level `Warn` by default; a `logLevel` setting turns on `Debug` | Batching keeps file writes off the run; a few lines per session at the default level |
| Old logs | Deleted at startup after 14 days | No unbounded growth |
| Print mode | Keeps logging to stderr, and writes the session file too | `-p` output stays as it is |
| Copying | Transcript text is `selectable`; `useSelectionHandler` copies the selection on mouse release with `createClipboard(...).writeText` (host clipboard, else OSC 52) | What OpenCode does; turning mouse capture off would lose wheel scrolling |
| Later | `tau debug <session>` prints the transcript and the log as one report | Not needed while the agent can read both files |

Open question: [questions.md](../questions.md) (does a failed run become a session entry).
