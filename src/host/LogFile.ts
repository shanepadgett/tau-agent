/** Writes this process's log as JSON Lines to a new file in `~/.tau/logs`, and removes log files older than 14 days. */

import { join } from "node:path";
import { Clock, Duration, Effect, FileSystem, Layer, Logger, Option, References } from "effect";
import { TauHome } from "../database/TauHome.ts";
import { Settings } from "./Settings.ts";

const KEEP_DAYS = 14;
const KEEP_MILLIS = Duration.toMillis(Duration.days(KEEP_DAYS));

/** The length of an ISO time up to its seconds, such as `2026-10-14T09:30:00`. */
const STAMP_LENGTH = 19;

/**
 * Takes the place of the console logger in every mode: the chat and the supervisor share the
 * terminal, and print mode keeps stdout for the answer.
 */
export const logFileLayer = Layer.unwrap(
  Effect.gen(function* () {
    const { directory } = yield* TauHome;
    const { logLevel } = yield* Settings;
    const fileSystem = yield* FileSystem.FileSystem;
    const folder = join(directory, "logs");
    const now = yield* Clock.currentTimeMillis;

    yield* fileSystem.makeDirectory(folder, { recursive: true });
    yield* removeOldLogs(folder, now);
    const path = join(folder, `${fileStamp(now)}-${process.pid}.jsonl`);

    return Layer.merge(
      Logger.layer([Logger.toFile(Logger.formatJson, path)]),
      Layer.succeed(References.MinimumLogLevel, logLevel),
    );
  }),
);

/** The time in UTC, such as `2026-10-14T09-30-00`, so file names sort by time. */
const fileStamp = (millis: number) =>
  new Date(millis).toISOString().slice(0, STAMP_LENGTH).replaceAll(":", "-");

const removeOldLogs = Effect.fn("removeOldLogs")(function* (folder: string, now: number) {
  const fileSystem = yield* FileSystem.FileSystem;
  const names = yield* fileSystem.readDirectory(folder);
  const logs = names.filter((name) => name.endsWith(".jsonl"));

  yield* Effect.forEach(logs, (name) => removeWhenOld(join(folder, name), now), { discard: true });
});

/** Another Tau can remove the same file at the same time, so a failure here changes nothing. */
const removeWhenOld = (path: string, now: number) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const { mtime } = yield* fileSystem.stat(path);
    const isOld = Option.exists(mtime, (changed) => now - changed.getTime() > KEEP_MILLIS);
    if (isOld) yield* fileSystem.remove(path, { force: true });
  }).pipe(Effect.ignore);
