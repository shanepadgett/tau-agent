/**
 * Makes the writes of one Tau process to one file wait for each other, so two edits to a file in
 * one script cannot lose one. It does not stop `sh` or another process from writing the file.
 */

import { basename, dirname, join } from "node:path";
import { Effect, FileSystem, RcMap, Semaphore } from "effect";

export type WriteQueue = {
  /** Runs `write` when no other write to the same file is running. */
  readonly withFile: <A, E, R>(
    path: string,
    write: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
};

/** One lock per real path, so a file reached through a symlinked folder shares its lock. */
export const makeWriteQueue = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;

  // A lock is freed when no write holds or waits for it, so the map does not grow.
  const locks = yield* RcMap.make({ lookup: (_path: string) => Semaphore.make(1) });

  // A file that does not exist yet has no real path; its folder may not exist either.
  const realFile = (path: string) =>
    fileSystem.realPath(path).pipe(
      Effect.catch(() =>
        fileSystem
          .realPath(dirname(path))
          .pipe(Effect.map((folder) => join(folder, basename(path)))),
      ),
      Effect.orElseSucceed(() => path),
    );

  const withFile = <A, E, R>(path: string, write: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const lock = yield* RcMap.get(locks, yield* realFile(path));
      return yield* lock.withPermit(write);
    }).pipe(Effect.scoped);

  const queue: WriteQueue = { withFile };
  return queue;
});
