/** Writes a file whole, so that a reader never sees half of it. */

import { join } from "node:path";
import { Crypto, Effect, FileSystem } from "effect";

/**
 * Writes `text` to `name` in `directory`, and makes the directory first. Two Tau processes can
 * write at the same time, so each writes a temporary file and renames it.
 */
export const replaceFile = Effect.fn("replaceFile")(function* (
  directory: string,
  name: string,
  text: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const crypto = yield* Crypto.Crypto;
  const path = join(directory, name);
  const temporary = `${path}.${yield* crypto.randomUUIDv4()}`;
  yield* fileSystem.makeDirectory(directory, { recursive: true });
  yield* fileSystem.writeFileString(temporary, text);
  yield* fileSystem.rename(temporary, path);
});
