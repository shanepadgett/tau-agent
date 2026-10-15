/** Runs `git clone` and reports its progress lines. */

import { Duration, Effect, Option, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { type CloneProgress, ReferenceFailed } from "../../core/References.ts";
import { errorLine } from "./git-run.ts";

const STALL_MINUTES = 3;
const KILLED_CHECK_SECONDS = 2;
const CLONE_STALL_TIMEOUT = Duration.minutes(STALL_MINUTES);
const KILLED_CHECK = Duration.seconds(KILLED_CHECK_SECONDS);

const PROGRESS_LINE =
  /(?<phase>Receiving objects|Resolving deltas|Updating files):\s+(?<percent>\d+)%/;

const PHASES: Readonly<Record<string, CloneProgress["phase"]>> = {
  "Receiving objects": "receiving",
  "Resolving deltas": "resolving",
  "Updating files": "updating",
};

const progressOf = (line: string): CloneProgress | undefined => {
  const match = PROGRESS_LINE.exec(line);
  const phase = PHASES[match?.groups?.["phase"] ?? ""];

  return match === null || phase === undefined
    ? undefined
    : { phase, percent: Number(match.groups?.["percent"]) };
};

/**
 * Clones `url` into `path`. Git sends its progress only on stderr. A clone that prints nothing for
 * three minutes is stopped.
 */
export const cloneInto = Effect.fn("cloneInto")(function* (
  reference: string,
  clone: { readonly folder: string; readonly url: string; readonly path: string },
  onProgress: (progress: CloneProgress) => Effect.Effect<void>,
) {
  const { folder, url, path } = clone;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const failed = (message: string) => new ReferenceFailed({ reference, message });

  const child = yield* spawner
    .spawn(
      ChildProcess.make("git", ["clone", "--progress", "--single-branch", url, path], {
        cwd: folder,
        stdin: "ignore",
        stdout: "ignore",
        killSignal: "SIGKILL",
      }),
    )
    .pipe(Effect.mapError((cause) => failed(cause.message)));

  let output: readonly string[] = [];

  yield* child.stderr.pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.timeout(CLONE_STALL_TIMEOUT),
    Stream.runForEach((line) => {
      output = [...output, line];
      const progress = progressOf(line);
      return progress === undefined ? Effect.void : onProgress(progress);
    }),
    Effect.mapError((cause) => failed(cause.message)),
  );

  const exitCode = yield* child.exitCode.pipe(
    Effect.timeoutOption(KILLED_CHECK),
    Effect.mapError((cause) => failed(cause.message)),
  );

  if (Option.isNone(exitCode))
    return yield* failed("The clone stalled with no output for 3 minutes.");

  if (exitCode.value !== 0) return yield* failed(errorLine(output.join("\n")));
}, Effect.scoped);
