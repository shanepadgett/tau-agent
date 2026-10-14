/** Shell commands and git repositories in temp folders, for tests of change detection and checks. */

import { Duration, Effect } from "effect";
import { runProgram } from "../../src/proc/Command.ts";

const SHELL_TIMEOUT = Duration.seconds(10);

/** Runs `command` in `directory` and fails the test when it exits with another code than 0. */
export const shell = Effect.fn("shell")(function* (directory: string, command: string) {
  const result = yield* runProgram("sh", ["-c", command], directory, SHELL_TIMEOUT);
  if (result.exitCode !== 0) return yield* Effect.die(`${command} failed: ${result.output}`);
  return result.output;
});

/** Makes `directory` a repository with one commit of `files`. Commits are not signed. */
export const initRepository = (directory: string, files: Readonly<Record<string, string>>) =>
  Effect.gen(function* () {
    yield* shell(directory, "git init -q");

    for (const [path, content] of Object.entries(files))
      yield* shell(
        directory,
        `mkdir -p "$(dirname '${path}')" && printf '%s' '${content}' > '${path}'`,
      );

    yield* shell(
      directory,
      "git add -A && git -c user.name=Tau -c user.email=tau@example.com -c commit.gpgsign=false commit -q --allow-empty -m start",
    );
  });
