/**
 * Takes snapshots of the files git sees as changed in a repository, and compares two snapshots,
 * so Tau knows which files a script changed, however it changed them.
 */

import { join } from "node:path";
import { Effect, FileSystem, Option, Schema } from "effect";
import { runProgram } from "../proc/Command.ts";
import { GIT_TIMEOUT } from "./Repository.ts";

/** Files over this size compare by size and change time, so a snapshot never reads a large file. */
const MAX_HASHED_BYTES = 2n * 1024n * 1024n;
const FILES_READ_AT_ONCE = 8;
const STATUS_CODE_LENGTH = 3;

/**
 * Each changed, untracked or deleted file, as a path from the repository root, with a text that
 * changes when the file's content does.
 */
export type Snapshot = ReadonlyMap<string, string>;

class SnapshotFailed extends Schema.TaggedError<SnapshotFailed>()("SnapshotFailed", {
  root: Schema.String,
  reason: Schema.String,
}) {
  override get message() {
    return `Tau cannot read the git status of ${this.root}: ${this.reason}.`;
  }
}

export const snapshot = Effect.fn("snapshot")(function* (root: string) {
  const status = yield* runProgram(
    "git",
    ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    root,
    GIT_TIMEOUT,
  ).pipe(Effect.mapError((error) => new SnapshotFailed({ root, reason: error.message })));

  if (status.exitCode !== 0) {
    const reason = `git status exited with code ${status.exitCode}`;
    return yield* new SnapshotFailed({ root, reason });
  }

  const paths = statusPaths(status.output);

  const versions = yield* Effect.forEach(
    paths,
    (path) => version(join(root, path)).pipe(Effect.map((text) => [path, text] as const)),
    { concurrency: FILES_READ_AT_ONCE },
  );

  const taken: Snapshot = new Map(versions);
  return taken;
});

/** The paths that differ between two snapshots, sorted. A file changed and changed back is equal. */
export const changedFiles = (before: Snapshot, after: Snapshot) =>
  [...new Set([...before.keys(), ...after.keys()])]
    .filter((path) => before.get(path) !== after.get(path))
    .toSorted();

/**
 * Reads `git status -z`: each record is a two-letter code, a space and a path. A rename or copy has
 * a second record with the old path, which is no longer there.
 */
const statusPaths = (output: string) => {
  const records = output.split("\0").filter((record) => record !== "");
  const paths: string[] = [];

  for (let index = 0; index < records.length; index++) {
    const record = records[index] ?? "";
    paths.push(record.slice(STATUS_CODE_LENGTH));

    const isMove = record.startsWith("R") || record.startsWith("C");
    if (isMove) paths.push(records[++index] ?? "");
  }

  return paths;
};

const version = Effect.fn("version")(function* (path: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const stat = yield* Effect.option(fileSystem.stat(path));
  if (Option.isNone(stat)) return "missing";

  const { type, size, mtime } = stat.value;

  if (type !== "File" || size > MAX_HASHED_BYTES) {
    const changedAt = Option.match(mtime, { onNone: () => 0, onSome: (date) => date.getTime() });
    return `size:${size}:${changedAt}`;
  }

  const content = yield* Effect.option(fileSystem.readFile(path));

  return Option.match(content, {
    onNone: () => "missing",
    onSome: (bytes) => `hash:${Bun.hash(bytes).toString()}`,
  });
});
