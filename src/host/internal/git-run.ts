/** Runs git in a reference folder and gives its output, or the line of git's error. */

import { Duration, Effect, Option, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { ReferenceFailed } from "../../core/References.ts";

const LOOKUP_SECONDS = 10;
const NETWORK_MINUTES = 5;

/** How long a local git command may run. */
export const LOOKUP_TIMEOUT = Duration.seconds(LOOKUP_SECONDS);

/** How long a git command that talks to the remote may run. */
export const NETWORK_TIMEOUT = Duration.minutes(NETWORK_MINUTES);

/** The line of git's output that says what failed: `fatal:` or `error:`, else the first line. */
export const errorLine = (output: string) => {
  const lines = output.split("\n").flatMap((line) => (line.trim() === "" ? [] : [line.trim()]));
  return lines.find((line) => /^(fatal|error):/.test(line)) ?? lines[0] ?? "git failed.";
};

/** Runs `git args` in `directory`. It fails with git's error line when the exit code is not 0. */
export const runGit = Effect.fn("runGit")(function* (
  reference: string,
  directory: string,
  args: readonly string[],
  timeout: Duration.Duration,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const finished = yield* Effect.scoped(
    Effect.gen(function* () {
      const child = yield* spawner.spawn(
        ChildProcess.make("git", args, { cwd: directory, stdin: "ignore", killSignal: "SIGKILL" }),
      );

      const output = yield* Stream.mkString(Stream.decodeText(child.all));
      return { exitCode: yield* child.exitCode, output };
    }),
  ).pipe(
    Effect.timeoutOption(timeout),
    Effect.mapError((cause) => new ReferenceFailed({ reference, message: cause.message })),
  );

  if (Option.isNone(finished)) {
    return yield* new ReferenceFailed({ reference, message: "git took too long." });
  }

  if (finished.value.exitCode !== 0) {
    return yield* new ReferenceFailed({ reference, message: errorLine(finished.value.output) });
  }

  return finished.value.output;
});
