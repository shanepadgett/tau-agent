/** Saves prepared pictures as files in the session's output folder, and reads picture files. */

import { Effect, FileSystem, Option } from "effect";
import type { ImageRef } from "../../../session/Entry.ts";
import { OutputFiles } from "../output/output-files.ts";
import { type PreparedImage, prepareImage } from "./prepare.ts";

const EXTENSIONS: Readonly<Record<ImageRef["mediaType"], string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

/** Writes the picture to a new file in the session's output folder. */
const saveImage = Effect.fn("saveImage")(function* (image: PreparedImage) {
  const path = yield* (yield* OutputFiles).next("image", EXTENSIONS[image.mediaType]);
  yield* (yield* FileSystem.FileSystem).writeFile(path, image.bytes);
  return { path, mediaType: image.mediaType } satisfies ImageRef;
});

/**
 * Prepares and saves the pictures a user sent. A picture that cannot be read is left out; the
 * clients check the file when the user adds it, so this is rare.
 */
export const saveImages = Effect.fn("saveImages")(function* (pictures: readonly Uint8Array[]) {
  const saved = yield* Effect.forEach(pictures, (bytes) =>
    saveImageBytes(bytes).pipe(Effect.option),
  );

  return saved.flatMap(Option.toArray);
});

/** Prepares the bytes of a picture and saves them. */
export const saveImageBytes = (bytes: Uint8Array) =>
  prepareImage(bytes).pipe(Effect.flatMap(saveImage));
