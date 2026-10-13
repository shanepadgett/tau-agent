/**
 * The built-in instruction sources: the agent instruction files, today's date, the environment and
 * the files in the session directory.
 */

import { arch, platform } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { Clock, Duration, Effect, FileSystem, Option } from "effect";
import { runCommand } from "../../../proc/Command.ts";
import type { Entry } from "../../../session/Entry.ts";
import { type InstructionSource, savedValues } from "./instructions.ts";

const GIT_TIMEOUT_SECONDS = 10;
const GIT_TIMEOUT = Duration.seconds(GIT_TIMEOUT_SECONDS);
const MAX_FILE_LINES = 200;
const AGENTS_FILE = "AGENTS.md";
const AGENTS_KEY = "agents:";

/** The session directory, and the user's own instruction files, most shared first. */
export type Where = { readonly directory: string; readonly userInstructions: readonly string[] };

/**
 * Every source for the next model call, most shared first, so the cached start of a request also
 * repeats across sessions. The instruction file of a subfolder comes in once a script touched a
 * file below it.
 */
export const instructionSources = Effect.fn("instructionSources")(function* (
  where: Where,
  entries: readonly Entry[],
) {
  const root = yield* repositoryRoot(where.directory);

  const levels = Option.isSome(root)
    ? levelsBelow(root.value, yield* realPath(where.directory))
    : 0;

  const agentsFiles = [
    ...where.userInstructions,
    ...foldersFromRoot(where.directory, levels).map((folder) => join(folder, AGENTS_FILE)),
    ...savedAgentsFiles(entries),
    ...agentsFilesAbove(where.directory, touchedFiles(entries)),
  ];

  return [
    ...[...new Set(agentsFiles)].map(agentsSource),
    dateSource,
    environmentSource(where.directory, root),
    filesSource(where.directory, root),
  ];
});

const repositoryRoot = (directory: string) =>
  runCommand("git rev-parse --show-toplevel", directory, GIT_TIMEOUT).pipe(
    Effect.map(({ exitCode, output }) =>
      exitCode === 0 ? Option.some(output.trim()) : Option.none<string>(),
    ),
    Effect.orElseSucceed(() => Option.none<string>()),
  );

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

const savedAgentsFiles = (entries: readonly Entry[]) =>
  Object.keys(savedValues(entries)).flatMap((key) =>
    key.startsWith(AGENTS_KEY) ? [key.slice(AGENTS_KEY.length)] : [],
  );

/** The files the scripts touched since the last reply. */
const touchedFiles = (entries: readonly Entry[]) => {
  const lastReply = entries.findLastIndex(({ body }) => body.type === "assistant");

  return entries
    .slice(lastReply + 1)
    .flatMap(({ body }) => (body.type === "tool-result" ? (body.files ?? []) : []));
};

/** The instruction files in the folders between `directory` and each file, from the top down. */
const agentsFilesAbove = (directory: string, files: readonly string[]) =>
  files.flatMap((file) => {
    const path = relative(directory, dirname(file));
    if (path === "" || path.startsWith("..") || isAbsolute(path)) return [];

    const folders = path.split(sep);
    return folders.map((_, index) => join(directory, ...folders.slice(0, index + 1), AGENTS_FILE));
  });

const agentsSource = (path: string) => ({
  key: `${AGENTS_KEY}${path}`,
  read: Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    if (!(yield* fileSystem.exists(path))) return Option.none<string>();
    return Option.some(yield* fileSystem.readFileString(path));
  }),
  first: (value: string) => `Instructions from ${path}:\n\n${value}`,
  changed: (value: string) => `${path} changed. It now says:\n\n${value}`,
  removed: `${path} was removed.`,
});

const dateFormat = new Intl.DateTimeFormat("en-GB", { dateStyle: "full" });

const dateSource: InstructionSource<never, never> = {
  key: "tau/date",
  read: Clock.currentTimeMillis.pipe(Effect.map((now) => Option.some(dateFormat.format(now)))),
  first: (value) => `Today's date is ${value}.`,
  changed: (value) => `Today's date is now ${value}.`,
  removed: "",
};

/** `root` is the repository root, or none outside a repository. */
const environmentSource = (directory: string, root: Option.Option<string>) => ({
  key: "tau/environment",
  read: Effect.succeed(
    Option.some(
      [
        "<environment>",
        `Session directory: ${directory}`,
        `Git repository: ${Option.isSome(root) ? "yes" : "no"}`,
        `System: ${platform()} ${arch()}`,
        "Shell commands run in sh.",
        "</environment>",
      ].join("\n"),
    ),
  ),
  first: (value: string) => value,
  changed: (value: string) => `The environment is now:\n${value}`,
  removed: "",
});

const filesSource = (directory: string, root: Option.Option<string>) => ({
  key: "tau/files",
  read: (Option.isSome(root) ? repositoryFiles(directory) : folderFiles(directory)).pipe(
    Effect.map((lines) => Option.some(capped(lines).join("\n"))),
  ),
  first: (value: string) => `The session directory, two levels deep:\n<files>\n${value}\n</files>`,
  changed: filesChanged,
  removed: "",
});

/** Only what was added and removed, so a change note stays short. */
const filesChanged = (value: string, previous: string) => {
  const now = value.split("\n");
  const before = previous.split("\n");
  const added = now.filter((line) => !before.includes(line));
  const removed = before.filter((line) => !now.includes(line));

  return [
    ...(added.length > 0 ? ["Files added:", ...added] : []),
    ...(removed.length > 0 ? ["Files removed:", ...removed] : []),
  ].join("\n");
};

const capped = (lines: readonly string[]) =>
  lines.length > MAX_FILE_LINES
    ? [...lines.slice(0, MAX_FILE_LINES), `… and ${lines.length - MAX_FILE_LINES} more`]
    : lines;

/** Files and folders two levels deep, without what `.gitignore` excludes. Folders end in `/`. */
const REPOSITORY_FILES =
  'git ls-files --cached --others --exclude-standard | awk -F/ \'NF > 1 { print $1 "/" } NF > 2 { print $1 "/" $2 "/" } NF <= 2 { print }\' | sort -u';

const repositoryFiles = (directory: string) =>
  runCommand(REPOSITORY_FILES, directory, GIT_TIMEOUT).pipe(
    Effect.flatMap(({ exitCode, output }) =>
      exitCode === 0
        ? Effect.succeed(output.split("\n").filter((line) => line !== ""))
        : folderFiles(directory),
    ),
  );

/** Outside a repository: files and folders two levels deep, without dot files and folders. */
const folderFiles = Effect.fn("folderFiles")(function* (directory: string) {
  const top = yield* namesIn(directory, "");

  const below = yield* Effect.forEach(
    top.filter((name) => name.endsWith("/")),
    (folder) => namesIn(join(directory, folder), folder),
  );

  return [...top, ...below.flat()].toSorted();
});

const namesIn = Effect.fn("namesIn")(function* (folder: string, prefix: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const names = (yield* fileSystem.readDirectory(folder)).filter((name) => !name.startsWith("."));

  return yield* Effect.forEach(names, (name) =>
    fileSystem
      .stat(join(folder, name))
      .pipe(
        Effect.map((fileInfo) =>
          fileInfo.type === "Directory" ? `${prefix}${name}/` : `${prefix}${name}`,
        ),
      ),
  );
});
