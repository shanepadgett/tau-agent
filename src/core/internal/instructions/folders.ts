/**
 * Finds the project folders of a session: the repository root and each folder down to the session
 * directory. Instruction files and skills are looked up in each of them.
 */

import { dirname, isAbsolute, relative, sep } from "node:path";
import { Effect, FileSystem, Option } from "effect";
import { repositoryRoot } from "../../../workspace/Repository.ts";

type ProjectFolders = {
  /** The repository root, or none outside a repository. */
  readonly root: Option.Option<string>;
  /** From the repository root down to the session directory. Outside git, only the directory. */
  readonly folders: readonly string[];
};

export const projectFolders = Effect.fn("projectFolders")(function* (directory: string) {
  const root = yield* repositoryRoot(directory);

  const levels = Option.isSome(root) ? levelsBelow(root.value, yield* realPath(directory)) : 0;

  const found: ProjectFolders = { root, folders: foldersFromRoot(directory, levels) };
  return found;
});

/** Git gives the root as a real path, so the session directory is compared as one too. */
const realPath = (directory: string) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fileSystem) => fileSystem.realPath(directory)),
    Effect.orElseSucceed(() => directory),
  );

const levelsBelow = (root: string, directory: string) => {
  const path = relative(root, directory);
  if (path === "" || path.startsWith("..") || isAbsolute(path)) return 0;
  return path.split(sep).length;
};

/** `directory` and the `levels` folders above it, from the top down. */
const foldersFromRoot = (directory: string, levels: number) => {
  const folders = [directory];
  for (let level = 0; level < levels; level++) folders.unshift(dirname(folders[0] ?? directory));
  return folders;
};
