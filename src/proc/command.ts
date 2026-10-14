/**
 * Runs shell commands and programs and returns their exit code and output. Ending one early, by a
 * timeout or an interruption, kills it and every process it started.
 */

import { Duration, Effect, Option, type PlatformError, Ref, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { captureOutput, CapturedOutput } from "./Output.ts";

/** Tau reads all of a program's output, so a program that prints more than this fails. */
const MAX_PROGRAM_OUTPUT_CHARACTERS = 10_000_000;

type CommandResult = { readonly exitCode: number; readonly output: string };

/**
 * A command for `sh -c`. `args` reach it as `"$@"`, so a path is never pasted into the command
 * text. `env` is added to Tau's own environment.
 */
export type ShellCommand = {
  readonly command: string;
  readonly directory: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly outputPath: string;
};

class ShellTimedOut extends Schema.TaggedError<ShellTimedOut>()("ShellTimedOut", {
  command: Schema.String,
  seconds: Schema.Finite,
  output: CapturedOutput,
}) {
  override get message() {
    return `The command did not finish in ${this.seconds} seconds, so Tau stopped it.`;
  }
}

class CommandTimedOut extends Schema.TaggedError<CommandTimedOut>()("CommandTimedOut", {
  command: Schema.String,
  seconds: Schema.Finite,
  output: Schema.String,
}) {
  override get message() {
    return `The command did not finish in ${this.seconds} seconds, so Tau stopped it.`;
  }
}

class OutputTooLarge extends Schema.TaggedError<OutputTooLarge>()("OutputTooLarge", {
  program: Schema.String,
  characters: Schema.Int,
}) {
  override get message() {
    return `${this.program} printed more than ${this.characters} characters, so Tau stopped it.`;
  }
}

/**
 * Runs `shell` with `sh -c`. stdout and stderr arrive in one text, in order. The command leads its
 * own process group, and closing the scope kills the group.
 */
export const runCommand = (shell: ShellCommand, timeout: Duration.Duration) =>
  Effect.scoped(
    Effect.gen(function* () {
      const child = yield* spawn(
        ChildProcess.make("sh", ["-c", shell.command, "sh", ...shell.args], {
          cwd: shell.directory,
          env: shell.env,
          extendEnv: true,
          stdin: "ignore",
          killSignal: "SIGKILL",
        }),
      );

      const capture = yield* captureOutput(shell.outputPath);
      const reading = Stream.runForEach(child.all, capture.accept);

      const finished = yield* Effect.all([child.exitCode, reading], {
        concurrency: "unbounded",
      }).pipe(Effect.timeoutOption(timeout));

      const output = yield* capture.result;

      if (Option.isNone(finished)) {
        const seconds = Duration.toSeconds(timeout);
        return yield* new ShellTimedOut({ command: shell.command, seconds, output });
      }

      const completed = { exitCode: finished.value[0], output };
      return completed;
    }),
  );

/**
 * Runs `program` with `args` and no shell, and gives its stdout whole. Output over the limit fails,
 * because a cut text would read as a wrong answer. stderr is dropped.
 */
export const runProgram = (
  program: string,
  args: readonly string[],
  directory: string,
  timeout: Duration.Duration,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const child = yield* spawn(
        ChildProcess.make(program, args, {
          cwd: directory,
          stdin: "ignore",
          stderr: "ignore",
          killSignal: "SIGKILL",
        }),
      );

      const withinLimit = (text: string) =>
        text.length > MAX_PROGRAM_OUTPUT_CHARACTERS
          ? Effect.fail(new OutputTooLarge({ program, characters: MAX_PROGRAM_OUTPUT_CHARACTERS }))
          : Effect.succeed(text);

      const ran = yield* collect(child.exitCode, child.stdout, withinLimit, timeout);

      if (Option.isNone(ran.exitCode)) {
        const seconds = Duration.toSeconds(timeout);
        return yield* new CommandTimedOut({ command: program, seconds, output: ran.output });
      }

      const completed: CommandResult = { exitCode: ran.exitCode.value, output: ran.output };
      return completed;
    }),
  );

const spawn = (command: ChildProcess.Command) =>
  ChildProcessSpawner.ChildProcessSpawner.pipe(Effect.flatMap((spawner) => spawner.spawn(command)));

/**
 * Reads `output` until the process exits, passing the text so far through `accept`. The exit code
 * is none when `timeout` passed first.
 */
const collect = Effect.fn("collect")(function* <E>(
  exitCode: Effect.Effect<number, PlatformError.PlatformError>,
  output: Stream.Stream<Uint8Array, PlatformError.PlatformError>,
  accept: (text: string) => Effect.Effect<string, E>,
  timeout: Duration.Duration,
) {
  const received = yield* Ref.make("");

  const reading = output.pipe(
    Stream.decodeText(),
    Stream.runForEach((chunk) =>
      Ref.get(received).pipe(
        Effect.flatMap((text) => accept(text + chunk)),
        Effect.flatMap((text) => Ref.set(received, text)),
      ),
    ),
  );

  const finished = yield* Effect.all([exitCode, reading], { concurrency: "unbounded" }).pipe(
    Effect.timeoutOption(timeout),
  );

  return { exitCode: Option.map(finished, ([code]) => code), output: yield* Ref.get(received) };
});
