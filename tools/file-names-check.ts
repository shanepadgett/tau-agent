// Checks file names that lint cannot see. Git must track each file under its name on disk: on
// macOS a rename that changes only letter case is invisible to Git unless it goes through `git mv`.
// In src/, a layer's public modules are PascalCase and its internal/ files are kebab-case.

import { readdirSync } from "node:fs";
import { spawnSync } from "bun";

const CHECKED_FOLDERS = ["src", "tests", "tools"];
const ENTRY_POINT = "src/cli/main.ts";
const PASCAL_CASE = /^[A-Z][A-Za-z0-9]*\.tsx?$/;
const KEBAB_CASE = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z]+)*\.ts$/;
const LAYER_ROOT_DEPTH = 3;

const trackedPaths = (): string[] => {
  const listed = spawnSync([
    "git",
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "-z",
    ...CHECKED_FOLDERS,
  ]);

  return listed.stdout.toString().split("\0").filter(Boolean);
};

const folderNames = new Map<string, readonly string[]>();

const namesIn = (folder: string): readonly string[] => {
  const cached = folderNames.get(folder);
  if (cached !== undefined) return cached;

  const names = readdirSync(folder);
  folderNames.set(folder, names);
  return names;
};

/** The path with each part spelled as on disk, or undefined when the file is gone. */
const diskPath = (path: string): string | undefined => {
  const parts: string[] = [];

  for (const part of path.split("/")) {
    const folder = parts.length === 0 ? "." : parts.join("/");
    const onDisk = namesIn(folder).find((name) => name.toLowerCase() === part.toLowerCase());

    if (onDisk === undefined) return undefined;
    parts.push(onDisk);
  }

  return parts.join("/");
};

const caseProblem = (path: string, onDisk: string): string | undefined =>
  onDisk === path
    ? undefined
    : `${path}: Git tracks this name, but the file on disk is ${onDisk}. Run \`git mv ${path} ${onDisk}\`.`;

const namingProblem = (path: string): string | undefined => {
  const parts = path.split("/");
  const name = parts.at(-1) ?? path;
  const isCode = name.endsWith(".ts") || name.endsWith(".tsx");

  if (parts[0] !== "src" || !isCode || path === ENTRY_POINT) return undefined;

  if (parts.includes("internal")) {
    const fits = name.endsWith(".tsx") ? PASCAL_CASE.test(name) : KEBAB_CASE.test(name);

    return fits
      ? undefined
      : `${path}: name files in internal/ in kebab-case, and components (.tsx) in PascalCase.`;
  }

  if (parts.length === LAYER_ROOT_DEPTH && !PASCAL_CASE.test(name))
    return `${path}: name a layer's public module in PascalCase, after what it exports. Rename it with \`git mv\`.`;

  return undefined;
};

// A file Git tracks but the worktree deleted has no name to check.
const problems = trackedPaths().flatMap((path) => {
  const onDisk = diskPath(path);
  if (onDisk === undefined) return [];

  return [caseProblem(path, onDisk) ?? namingProblem(onDisk)].filter(
    (problem) => problem !== undefined,
  );
});

for (const problem of problems) console.log(problem);
process.exit(problems.length === 0 ? 0 : 1);
