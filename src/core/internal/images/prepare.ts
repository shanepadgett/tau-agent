/** Shrinks a picture to a size models accept and encodes it as PNG, JPEG or WebP. */

import { Effect, Schema } from "effect";
import type { ImageRef } from "../../../session/Entry.ts";

type MediaType = ImageRef["mediaType"];

/** Providers resize anything longer than this, so a larger picture only costs upload time. */
const MAX_EDGE = 1568;
const BYTES_PER_MEBIBYTE = 1_048_576;
/** Anthropic refuses a picture over 5 MiB. */
const MAX_MEBIBYTES = 5;
const MAX_BYTES = MAX_MEBIBYTES * BYTES_PER_MEBIBYTE;
const JPEG_QUALITY = 80;

class UnreadableImage extends Schema.TaggedError<UnreadableImage>()("UnreadableImage", {
  cause: Schema.Defect(),
}) {
  override get message() {
    return "The file is not a picture Tau can read. PNG, JPEG, WebP, GIF and BMP work.";
  }
}

export type PreparedImage = { readonly bytes: Uint8Array; readonly mediaType: MediaType };

/** A picture keeps its format when Tau can send it; any other format becomes PNG. */
const SENT_FORMATS: Readonly<Record<string, MediaType>> = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

const attempt = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: (cause) => new UnreadableImage({ cause }) });

const fitted = (bytes: Uint8Array) =>
  new Bun.Image(bytes).resize(MAX_EDGE, MAX_EDGE, { fit: "inside", withoutEnlargement: true });

const encoded = (bytes: Uint8Array, mediaType: MediaType) => {
  switch (mediaType) {
    case "image/jpeg":
      return fitted(bytes).jpeg();
    case "image/webp":
      return fitted(bytes).webp();
    case "image/png":
      return fitted(bytes).png();
  }
};

/**
 * Applies the picture's EXIF rotation, fits it within 1568 pixels without enlarging it and
 * encodes it again. A result over the byte limit becomes a JPEG.
 */
export const prepareImage = Effect.fn("prepareImage")(function* (bytes: Uint8Array) {
  const { format } = yield* attempt(() => new Bun.Image(bytes).metadata());
  const mediaType = SENT_FORMATS[format] ?? "image/png";

  const first = yield* attempt(() => encoded(bytes, mediaType).bytes());
  if (first.length <= MAX_BYTES) return { bytes: first, mediaType } satisfies PreparedImage;

  const smaller = yield* attempt(() => fitted(bytes).jpeg({ quality: JPEG_QUALITY }).bytes());
  return { bytes: smaller, mediaType: "image/jpeg" } satisfies PreparedImage;
});
