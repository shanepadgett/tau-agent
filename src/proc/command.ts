/**
 * Runs one shell command and returns its exit code and output. Ending the command early, by a
 * timeout or an interruption, kills the command and every process it started.
 */

import { Duration, Effect, Option, Schema, Stream } from "effect";

/** Output is cut to this many characters, keeping the start and the end. */
const MAX_OUTPUT_CHARACTERS = 50_000;
const KEPT_AT_EACH_END = MAX_OUTPUT_CHARACTERS / 2;

type CommandResult = { readonly exitCode: number; readonly output: string };

class CommandTimedOut extends Schema.TaggedError<CommandTimedOut>()("CommandTimedOut", {
  command: Schema.String,
  seconds: Schema.Finite,
  output: Schema.String,
}) {
  override get message() {
    return `The command did not finish in ${this.seconds} seconds, so Tau stopped it.`;
  }
}

/** Runs `command` with `sh -c` in `directory`. stdout and stderr arrive in one text, in order. */
export const runCommand = (command: string, directory: string, timeout: Duration.Duration) =>
  Effect.scoped(
    Effect.gen(function* () {
      const chunks: string[] = [];

      const child = yield* Effect.acquireRelease(
        Effect.sync(() =>
          Bun.spawn(["sh", "-c", command], {
            cwd: directory,
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
            // The command leads its own process group, so one signal stops everything it started.
            detached: true,
          }),
        ),
        (started) => killGroup(started.pid),
      );

      const finished = yield* Effect.all(
        [
          Effect.promise(() => child.exited),
          collect(child.stdout, chunks),
          collect(child.stderr, chunks),
        ],
        { concurrency: "unbounded" },
      ).pipe(Effect.timeoutOption(timeout));

      const output = capped(chunks.join(""));

      if (Option.isNone(finished)) {
        const seconds = Duration.toSeconds(timeout);
        return yield* new CommandTimedOut({ command, seconds, output });
      }

      return { exitCode: finished.value[0], output } satisfies CommandResult;
    }),
  );

const collect = (stream: ReadableStream<Uint8Array>, chunks: string[]) =>
  Stream.fromReadableStream({ evaluate: () => stream, onError: (cause) => cause }).pipe(
    Stream.decodeText,
    Stream.runForEach((chunk) => Effect.sync(() => chunks.push(chunk))),
    // A pipe that fails to read loses only the rest of that output.
    Effect.ignore,
  );

// The group is often gone already: the command ended and started nothing that still runs.
const killGroup = (pid: number) =>
  Effect.try(() => process.kill(-pid, "SIGKILL")).pipe(Effect.ignore);

const capped = (output: string) => {
  if (output.length <= MAX_OUTPUT_CHARACTERS) return output;
  const removed = output.length - MAX_OUTPUT_CHARACTERS;

  return [
    output.slice(0, KEPT_AT_EACH_END),
    `\n[${removed} characters removed]\n`,
    output.slice(-KEPT_AT_EACH_END),
  ].join("");
};
