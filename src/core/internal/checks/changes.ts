/**
 * Finds the files a script changed from git snapshots before and after it, and runs the fixers on
 * them silently.
 */

import { Effect, Option } from "effect";
import type { Changes } from "../../../session/Entry.ts";
import { changedFiles, type Snapshot, snapshot } from "../../../workspace/Snapshot.ts";
import type { ProjectChecks } from "./checks-file.ts";
import { dueChecks, runChecks } from "./run-checks.ts";

const UNKNOWN: Changes = { type: "unknown" };

const changedPaths = (paths: readonly string[]): Changes => ({ type: "files", paths: [...paths] });

/** Runs `work` and gives its result with the files it changed. */
export const withChanges = Effect.fn("withChanges")(function* <A, E, R>(
  checks: ProjectChecks,
  work: Effect.Effect<A, E, R>,
) {
  if (checks.detection === "none") return [yield* work, UNKNOWN] as const;

  const before = yield* currentSnapshot(checks.root);
  const done = yield* work;
  return [done, yield* changesSince(checks, before)] as const;
});

/** A snapshot that git could not take leaves the changes unknown, so every check runs. */
const currentSnapshot = (root: string) =>
  snapshot(root).pipe(
    Effect.map(Option.some),
    Effect.catchTag("SnapshotFailed", (error) =>
      Effect.logWarning(error.message).pipe(Effect.as(Option.none<Snapshot>())),
    ),
  );

const changesSince = Effect.fn("changesSince")(function* (
  checks: ProjectChecks,
  before: Option.Option<Snapshot>,
) {
  if (Option.isNone(before)) return UNKNOWN;
  const after = yield* currentSnapshot(checks.root);
  if (Option.isNone(after)) return UNKNOWN;

  const changed = changedPaths(changedFiles(before.value, after.value));
  const fixers = yield* dueChecks(checks.fix, checks.root, changed);
  if (fixers.length === 0) return changed;

  yield* runChecks(fixers);
  const fixed = yield* currentSnapshot(checks.root);

  return Option.match(fixed, {
    onNone: () => UNKNOWN,
    onSome: (taken) => changedPaths(changedFiles(before.value, taken)),
  });
});
