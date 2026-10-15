/** Finds the git repository a folder is in. Outside a repository, or without git, there is none. */

import { Duration, Effect, Option } from "effect";
import { runProgram } from "../proc/Command.ts";

const GIT_TIMEOUT_SECONDS = 10;
export const GIT_TIMEOUT = Duration.seconds(GIT_TIMEOUT_SECONDS);

/** The root folder of the repository `directory` is in, as a real path. */
export const repositoryRoot = (directory: string) =>
  runProgram("git", ["rev-parse", "--show-toplevel"], directory, GIT_TIMEOUT).pipe(
    Effect.map(({ exitCode, output }) =>
      exitCode === 0 ? Option.some(output.trim()) : Option.none<string>(),
    ),
    Effect.orElseSucceed(() => Option.none<string>()),
  );

/**
 * The names directly in `folder` that git ignores. Outside a repository, or without git, there are
 * none.
 */
export const ignoredNames = (folder: string) =>
  runProgram(
    "git",
    ["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"],
    folder,
    GIT_TIMEOUT,
  ).pipe(
    Effect.map(({ exitCode, output }): ReadonlySet<string> =>
      exitCode === 0 ? new Set(output.split("\0").flatMap(directName)) : new Set(),
    ),
    Effect.orElseSucceed((): ReadonlySet<string> => new Set()),
  );

/** git names an ignored folder with a trailing `/`; deeper paths are not in the folder itself. */
const directName = (path: string) => {
  const name = path.replace(/\/$/, "");
  return name === "" || name.includes("/") ? [] : [name];
};
