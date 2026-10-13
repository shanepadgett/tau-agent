/**
 * Runs one shell command and returns its exit code and output. Ending the command early, by a
 * timeout or an interruption, kills the command and every process it started.
 */

import { Duration, Effect, Option, Ref, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

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

/**
 * Runs `command` with `sh -c` in `directory`. stdout and stderr arrive in one text, in order. The
 * command leads its own process group, and closing the scope kills the group.
 */
export const runCommand = (command: string, directory: string, timeout: Duration.Duration) =>
  Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const received = yield* Ref.make("");

      const child = yield* spawner.spawn(
        ChildProcess.make("sh", ["-c", command], {
          cwd: directory,
          stdin: "ignore",
          killSignal: "SIGKILL",
        }),
      );

      const collect = child.all.pipe(
        Stream.decodeText(),
        Stream.runForEach((chunk) => Ref.update(received, (text) => text + chunk)),
      );

      const finished = yield* Effect.all([child.exitCode, collect], {
        concurrency: "unbounded",
      }).pipe(Effect.timeoutOption(timeout));

      const output = capped(yield* Ref.get(received));

      if (Option.isNone(finished)) {
        const seconds = Duration.toSeconds(timeout);
        return yield* new CommandTimedOut({ command, seconds, output });
      }

      const completed: CommandResult = { exitCode: finished.value[0], output };
      return completed;
    }),
  );

const capped = (output: string) => {
  if (output.length <= MAX_OUTPUT_CHARACTERS) return output;
  const removed = output.length - MAX_OUTPUT_CHARACTERS;

  return [
    output.slice(0, KEPT_AT_EACH_END),
    `\n[${removed} characters removed]\n`,
    output.slice(-KEPT_AT_EACH_END),
  ].join("");
};
