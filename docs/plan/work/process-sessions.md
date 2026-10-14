# Step 5, slice 5b: process sessions

Status: implemented; repository checks pending the user's review, 2026-10-14. Part of [compaction.md](compaction.md).

**What the user gets:** the agent starts a command, such as a dev server, a watcher or a REPL, leaves it running and comes back to it. The TUI shows the running sessions in the sidebar `tasks` area, and the user can read and stop them. The agent can also wait on a process without blocking for its whole timeout, so a stuck command is caught in seconds.

## Agreed rules

| Rule | Decision |
| --- | --- |
| Lifetime | A process session lives until its Tau session is closed or switched away from, or Tau exits; it does not end with a run. `proc` kills the whole tree on close. Surviving Tau's exit is not built: it needs a supervisor the PTY spike did not prove |
| Terminal | Plain pipes by default; the agent asks for a PTY when a program needs one (REPL, `ssh`, a prompt). The user can attach to a PTY session from the TUI. Pipe output is clean lines; PTY output keeps what the terminal prints |
| Model awareness | Functions inside `run` (start, list, read, write, kill), plus a saved notice entry when a session exits or crashes while the agent works, plus the live session list shown in the view after a checkpoint. Nothing is added before every model call, so the prompt cache holds |
| Wait | A `wait` function in `run`, inside the run. It returns on process exit, a matching output line, a quiet period or a deadline, whichever is first; then the agent decides to kill, keep waiting or move on. No unprompted run: a wake after the run ends is not built |
| Wait conditions | The agent passes the pattern, the quiet period and the deadline. A plain `wait(session)` ends on exit or after 30 seconds of silence. No error-looking-line heuristics: they wake falsely on passing tests |
| Wait output | Output since the agent's last read, with the whole buffer readable on request; when nothing new arrived (a hang), the last few lines |
| Limits (from Codex, to confirm) | Start wait 250 ms to 30 s, at most 64 sessions, 1 MiB head-and-tail buffer per session |

Evidence: `spikes/pty/NOTES.md` (a PTY needs `detached: true`, an explicit tree kill and an explicit terminal close; not tested: heavy output, 64 sessions, descendants spawned during a cancel).

## Today

| Piece | Where | Changes |
| --- | --- | --- |
| `sh` | `run-tool.ts` → `proc/Command.ts` `runCommand` | stays: waits for exit or timeout, no stdin |
| Output capture | `proc/Output.ts` `captureOutput` | stays for `sh`; sessions need a different buffer (1 MiB head and tail, read cursor) |
| Session lifetime | `makeRunner` in `runner/runner.ts`, scoped to `Agent.open` | owns the registry; its scope closing kills every tree |
| `run` functions | `runner.ts` builds `{ sh, files, history, skills }` per run | adds a `process` group |
| Hidden notices | `RunContext.nudge` is pure on entries; `updateInstructions` is an effect | a new effectful `processNotices` beside `updateInstructions` |
| Checkpoint | `checkpointTool` pins notes and memory in `CheckpointDetails` | also pins the live process list |

## Files

```text
src/proc/
  ProcessSessions.ts      new: makeProcessSessions (registry), ProcessInfo, wait conditions
  internal/
    session-buffer.ts     new: capped head-and-tail buffer with a read cursor
    spawn-pipes.ts        new: Transport over Effect's ChildProcessSpawner, detached, group kill
    spawn-pty.ts          new: Transport over Bun.spawn + Bun.Terminal, descendant-snapshot kill
src/core/internal/process/
  process-functions.ts    new: the `process` run-function group (start, list, read, write, wait, kill)
  process-notices.ts      new: exit notices as nudge entries
src/core/internal/runner/runner.ts   changed: registry per runner; adds the group and notices
src/core/internal/loop/run-context.ts changed: processNotices hook
src/core/internal/loop/step.ts       changed: saves the notice before a model call
src/core/internal/context/notes/checkpoint.ts, view.ts  changed: pin and show the list
src/session/Entry.ts     changed: CheckpointDetails gains optional `processes`
tests/proc/process-sessions.test.ts, tests/core/process-sessions.test.ts  new
docs/guide/process-sessions.md  new
```

`proc` stays a leaf: it imports no `core` or `session` types.

## Types

```ts
// proc/ProcessSessions.ts
type StartOptions = { command: string; directory: string; pty: boolean };

type ProcessInfo = {
  id: string;                     // "p1", "p2", numbered per registry
  command: string; pty: boolean;
  state: { type: "running" } | { type: "exited"; exitCode: number } | { type: "killed" };
};

type WaitConditions = {           // all optional; the agent's `wait(id)` alone uses the defaults
  pattern?: RegExp;               // an output line matches
  quietSeconds: number;           // default 30
  deadlineSeconds: number;        // default: until the run's own timeout stops the script
};

type WaitResult =
  | { reason: "exited"; exitCode: number; output: string }
  | { reason: "matched" | "quiet" | "deadline"; output: string; tail: string | undefined };
// output: text since the last read; tail: last lines, set only when nothing new arrived

type ProcessSessions = {
  start: (options: StartOptions) => Effect<ProcessInfo, ProcessLimit | PlatformError>;
  list: Effect<readonly ProcessInfo[]>;
  read: (id) => Effect<{ output: string; info: ProcessInfo }, UnknownProcess>;      // since last read
  readAll: (id) => Effect<string, UnknownProcess>;                                   // whole buffer
  write: (id, text) => Effect<void, UnknownProcess | ProcessNotRunning>;
  wait: (id, WaitConditions) => Effect<WaitResult, UnknownProcess>;
  kill: (id) => Effect<ProcessInfo, UnknownProcess>;
  exits: Effect<readonly ProcessInfo[]>;                                             // exited or killed, for notices
};
makeProcessSessions: (limits) => Effect<ProcessSessions, never, Scope | ChildProcessSpawner | FileSystem>;

// internal: both spawners give the registry the same shape
type Transport = {
  output: Stream<Uint8Array>; write: (text) => Effect<void>;
  exit: Effect<number>; kill: Effect<void>;      // kills the whole tree, escalating to SIGKILL
};

// session/Entry.ts: absent on older checkpoints
CheckpointDetails = { …, processes?: readonly { id: string; command: string; pty: boolean }[] }
```

`start` takes the same `wait` conditions as a short first wait (default 1 second, at most 30): a command that ends in time returns output and exit code at once; otherwise it returns the id and the output so far. Over 64 live sessions, `start` fails with `ProcessLimit`. Buffer cap 1 MiB per session, head and tail; the whole stream is not spilled to a file in this slice.

## Call path

```text
runner opens a session → makeProcessSessions in the runner's scope (finalizer kills every tree)
run script: await tools.process.start({ command: "bun dev", waitSeconds: 2 })
  → ProcessSessions.start → Transport (pipes or PTY) → buffer fills from a forked reader
await tools.process.wait({ id, pattern: "ready", quietSeconds: 30 })
  → race: exit | pattern line | 30 s without output | deadline
await tools.process.read({ id }) / write / kill
before each model call: step saves processNotices(entries) → a nudge entry "process:p1" with the
  exit code and the last lines, once per process (the key is in entries, so nothing is kept in memory)
checkpoint tool: details.processes = registry.list filtered to running; the view adds them to the
  handoff message ("Running process sessions: p1 `bun dev` …")
```

A script that times out or fails does not kill its process sessions; they end only through `kill`, their own exit or the registry scope closing. The `run` description says so, and says that `wait`'s deadline cannot outlast the script's own timeout.

## Tests

Real processes (`sh -c`, `printf`, `sleep`, short deadlines), no fakes for the transports.

| Test | Passes when |
| --- | --- |
| Short command | `start` on `echo hi` returns the output and exit code 0 without a session id left running |
| Long command | `start` on `sleep 30` returns an id; `list` shows it running; `kill` ends the tree and no process remains |
| Wait conditions | `wait` ends on exit, on a matching line, on quiet and on the deadline, each with its reason; a quiet wait returns the tail |
| Since last read | A second `read` returns only new output; `readAll` returns everything |
| Buffer cap | A command printing 5 MiB keeps a 1 MiB head and tail and the registry stays responsive |
| Stdin | `write` to `cat` shows the text in `read` (pipes), and to `python3` in a PTY gets `42` for `6 * 7` |
| Limit | The 65th live `start` fails with `ProcessLimit` |
| Close | Closing the registry scope kills every tree, including a shell's background job |
| Notice | A session that exits mid-run gives one nudge entry before the next model call, and none after a restart that finds the key |
| Checkpoint | A checkpoint saves the live list; the next view shows it after the handoff; an older checkpoint without `processes` loads |
| Script fails | A `run` script that times out leaves its session running |

## As built

Where the build differs from the plan above:

- `start` returns `{ process, waited }`: the session summary and the first wait's result.
- `takeExits` keeps an in-memory "reported" flag per session; the notice key `process:<id>` is not looked up in entries. A reopened Tau session starts with an empty registry, so nothing is reported again.
- Exited and killed sessions stay in the registry (counted in `list`), and only running sessions count toward the limit of 64.
- The registry is made per session in `runPrompt`, and its scope close kills every tree.
- The TUI's sidebar and PTY attach need only `ProcessSessions.list` and `write`; this slice adds no `AgentEvent`.
- A child spawned during a PTY kill can escape, and a group kill after the root exited could hit a reused pid. Both are in [deferred.md](../deferred.md).
