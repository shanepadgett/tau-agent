/**
 * Runs a shell command on a pseudo-terminal, for programs that need one: a REPL, `ssh`, a prompt.
 * Killing it signals the command's descendants first, then the command, and closes the terminal.
 */

import { type Cause, Duration, Effect, Queue, Schema, Stream } from "effect";
import { ChildProcessSpawner } from "effect/process";
import { runProgram } from "../Command.ts";
import type { ShellStart, Transport } from "./transport.ts";

const COLUMNS = 80;
const ROWS = 24;
const PS_TIMEOUT_SECONDS = 5;
const DESCENDANTS_GRACE_MILLIS = 200;
const ROOT_GRACE_MILLIS = 500;
const PS_TIMEOUT = Duration.seconds(PS_TIMEOUT_SECONDS);
const DESCENDANTS_GRACE = Duration.millis(DESCENDANTS_GRACE_MILLIS);
const ROOT_GRACE = Duration.millis(ROOT_GRACE_MILLIS);

class PtyStartFailed extends Schema.TaggedError<PtyStartFailed>()("PtyStartFailed", {
  cause: Schema.Defect(),
}) {}

type ProcessRow = { readonly pid: number; readonly parent: number };

/** The part of a spawned command that killing it needs. */
type PtyRoot = { readonly pid: number; readonly exited: Promise<number> };

export const spawnPty = Effect.fn("spawnPty")(function* (shell: ShellStart) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const output = yield* Queue.unbounded<Uint8Array, Cause.Done>();

  const terminal = new Bun.Terminal({
    cols: COLUMNS,
    rows: ROWS,
    data: (_terminal, bytes) => {
      Queue.offerUnsafe(output, bytes);
    },
    exit: () => {
      Queue.endUnsafe(output);
    },
  });

  const child = yield* Effect.try({
    try: () =>
      Bun.spawn(["sh", "-c", shell.command], { cwd: shell.directory, terminal, detached: true }),
    catch: (cause) => new PtyStartFailed({ cause }),
  }).pipe(
    Effect.onError(() =>
      Effect.sync(() => {
        terminal.close();
      }),
    ),
  );

  const kill = killTree(child, terminal, shell.directory).pipe(
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
  );

  const transport: Transport = {
    output: Stream.fromQueue(output),
    write: (text) => Effect.sync(() => terminal.write(text)).pipe(Effect.asVoid),
    exitCode: Effect.promise(() => child.exited),
    kill,
  };

  return transport;
});

const killTree = Effect.fn("killPtyTree")(function* (
  child: PtyRoot,
  terminal: Bun.Terminal,
  directory: string,
) {
  if (terminal.closed) return;

  const descendants = descendantsOf(child.pid, yield* processTable(directory));

  if (descendants.length > 0) {
    for (const pid of descendants) signal(pid, "SIGTERM");
    yield* Effect.sleep(DESCENDANTS_GRACE);
    for (const pid of descendants) signal(pid, "SIGKILL");
  }

  signal(child.pid, "SIGTERM");
  yield* Effect.promise(() => child.exited).pipe(Effect.timeoutOption(ROOT_GRACE));
  signal(child.pid, "SIGKILL");
  signal(-child.pid, "SIGKILL");
  yield* Effect.promise(() => child.exited);

  terminal.close();
});

/** Every process in the system with its parent. */
const processTable = (directory: string) =>
  runProgram("/bin/ps", ["-axo", "pid=,ppid="], directory, PS_TIMEOUT).pipe(
    Effect.map(({ output }) => parseTable(output)),
    Effect.catch((error) =>
      Effect.logWarning(`Could not list processes to stop a PTY command: ${error.message}`).pipe(
        Effect.as<readonly ProcessRow[]>([]),
      ),
    ),
  );

const parseTable = (text: string): readonly ProcessRow[] =>
  text
    .trim()
    .split("\n")
    .map((line) => {
      const [pid, parent] = line.trim().split(/\s+/).map(Number);
      return { pid: pid ?? 0, parent: parent ?? 0 };
    });

/** The processes below `root`, children before their parents. */
const descendantsOf = (root: number, table: readonly ProcessRow[]): readonly number[] => {
  const found = [root];

  for (const pid of found) {
    for (const row of table) {
      if (row.parent === pid && !found.includes(row.pid)) found.push(row.pid);
    }
  }

  return found.slice(1).reverse();
};

/** Sends a signal to a process, which may already be gone. */
const signal = (pid: number, name: NodeJS.Signals) => {
  try {
    process.kill(pid, name);
  } catch {
    // A process that cannot be signaled is gone or not ours; there is nothing left to stop.
  }
};
