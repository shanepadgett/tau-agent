/**
 * The built-in instruction sources: agents files, instruction files, the skill list, today's
 * date, the environment and the files in the session directory.
 */

import { arch, platform } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { Clock, Effect, FileSystem, Option } from "effect";
import { runProgram } from "../../../proc/Command.ts";
import { GIT_TIMEOUT } from "../../../workspace/Repository.ts";
import type { Entry } from "../../../session/Entry.ts";
import type { UserInstructions } from "../../UserInstructions.ts";
import { type FoundSkills, skillListSource } from "../skills/skills.ts";
import { projectFolders } from "./folders.ts";
import { alwaysSources, findInstructionFiles, readWhenSource } from "./instruction-files.ts";
import { fileSource, type InstructionSource, savedPaths } from "./instructions.ts";

const MAX_FILE_LINES = 200;
const AGENTS_FILE = "AGENTS.md";
const AGENTS_KEY = "agents:";

/** The session directory, what the user set up, and the skills found for the run. */
export type Where = {
  readonly directory: string;
  readonly user: UserInstructions["Service"];
  readonly skills: FoundSkills;
};

/**
 * Every source for the next model call, most shared first, so the cached start of a request also
 * repeats across sessions. The agents file of a subfolder comes in once a script touched a file
 * below it.
 */
export const instructionSources = Effect.fn("instructionSources")(function* (
  where: Where,
  entries: readonly Entry[],
) {
  const { root, folders } = yield* projectFolders(where.directory);

  const files = yield* findInstructionFiles([
    ...where.user.instructionFolders,
    ...folders.map((folder) => join(folder, ".tau", "instructions")),
  ]);

  return [
    ...agentsSources(where, folders, entries),
    ...alwaysSources(files, entries),
    readWhenSource(files),
    skillListSource(where.skills, entries),
    dateSource,
    environmentSource(where.directory, root),
    filesSource(where.directory, root),
  ];
});

/** With agents files turned off, only the saved ones have a source, and each reads as removed. */
const agentsSources = (where: Where, folders: readonly string[], entries: readonly Entry[]) => {
  const saved = savedPaths(entries, AGENTS_KEY);

  if (!where.user.agentsFiles) {
    return saved.map((path) =>
      fileSource(`${AGENTS_KEY}${path}`, path, Effect.succeed(Option.none<string>())),
    );
  }

  const paths = [
    ...where.user.files,
    ...folders.map((folder) => join(folder, AGENTS_FILE)),
    ...saved,
    ...agentsFilesAbove(where.directory, touchedFiles(entries)),
  ];

  return [...new Set(paths)].map((path) =>
    fileSource(`${AGENTS_KEY}${path}`, path, readIfExists(path)),
  );
};

/** The files the scripts touched since the last reply. */
const touchedFiles = (entries: readonly Entry[]) => {
  const lastReply = entries.findLastIndex(({ body }) => body.type === "assistant");

  return entries
    .slice(lastReply + 1)
    .flatMap(({ body }) =>
      body.type === "tool-result" && body.details?.tool === "run" ? body.details.files : [],
    );
};

/** The agents files in the folders between `directory` and each file, from the top down. */
const agentsFilesAbove = (directory: string, files: readonly string[]) =>
  files.flatMap((file) => {
    const path = relative(directory, dirname(file));
    if (path === "" || path.startsWith("..") || isAbsolute(path)) return [];

    const folders = path.split(sep);
    return folders.map((_, index) => join(directory, ...folders.slice(0, index + 1), AGENTS_FILE));
  });

const readIfExists = Effect.fn("readIfExists")(function* (path: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  if (!(yield* fileSystem.exists(path))) return Option.none<string>();
  return Option.some(yield* fileSystem.readFileString(path));
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
  runProgram("sh", ["-c", REPOSITORY_FILES], directory, GIT_TIMEOUT).pipe(
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
