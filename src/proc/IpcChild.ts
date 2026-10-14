/**
 * Starts a Bun program that talks to Tau over Bun IPC, such as the chat that the supervisor runs.
 * Closing the scope kills the program.
 */

import { type Cause, Effect, Queue, Stream } from "effect";

/**
 * Where the program's output goes. `terminal` gives it Tau's terminal; `captured` keeps its output
 * and error output for `exited` and gives it no input.
 */
export type ChildOutput = "terminal" | "captured";

type ChildExit = {
  readonly code: number;
  /** The program's output, then its error output, when it is `captured`; empty otherwise. */
  readonly output: string;
};

type IpcChild<Outgoing> = {
  /**
   * Each message the program sends, not yet parsed. The stream ends when the connection closes,
   * after the last message, so a reader that waits for `exited` after it sees every message.
   */
  readonly messages: Stream.Stream<unknown>;
  readonly send: (message: Outgoing) => Effect.Effect<void>;
  readonly exited: Effect.Effect<ChildExit>;
};

/**
 * Leaves the alternate screen, shows the cursor, resets colors, mouse reports, bracketed paste and
 * the kitty keyboard mode. A program that crashes with the terminal leaves these on.
 */
const TERMINAL_RESET =
  "\u001B[?1049l\u001B[?25h\u001B[0m\u001B[?1000l\u001B[?1002l\u001B[?1003l\u001B[?1006l\u001B[?2004l\u001B[<u";

/** Starts `command` (the program and its arguments) and connects to it over IPC. */
export const spawnIpcChild = Effect.fn("spawnIpcChild")(function* <Outgoing>(
  command: readonly string[],
  output: ChildOutput,
) {
  const messages = yield* Queue.unbounded<unknown, Cause.Done>();
  const isTerminal = output === "terminal";

  const child = yield* Effect.acquireRelease(
    Effect.sync(() =>
      Bun.spawn([...command], {
        stdin: isTerminal ? "inherit" : "ignore",
        stdout: isTerminal ? "inherit" : "pipe",
        stderr: isTerminal ? "inherit" : "pipe",
        ipc: (message) => {
          Queue.offerUnsafe(messages, message);
        },
        onDisconnect: () => {
          Queue.endUnsafe(messages);
        },
      }),
    ),
    (spawned) =>
      Effect.sync(() => {
        spawned.kill("SIGKILL");
      }),
  );

  const exited = Effect.gen(function* () {
    const code = yield* Effect.promise(() => child.exited);
    // A program that exits cleanly gives the terminal back itself.
    if (isTerminal && code !== 0) process.stdout.write(TERMINAL_RESET);

    const texts = yield* Effect.promise(() =>
      Promise.all([readText(child.stdout), readText(child.stderr)]),
    );

    const exit: ChildExit = { code, output: texts.join("") };
    return exit;
  });

  const ipcChild: IpcChild<Outgoing> = {
    messages: Stream.fromQueue(messages),
    // A message to a program that has exited is lost; its exit reports the outcome.
    send: (message) =>
      Effect.sync(() => {
        if (!child.killed) child.send(message);
      }),
    exited: yield* Effect.cached(exited),
  };

  return ipcChild;
});

const readText = (stream: ReadableStream<Uint8Array> | number | undefined) =>
  stream instanceof ReadableStream ? new Response(stream).text() : Promise.resolve("");
