/** Fills in the pictures of a prompt right before a request: their bytes, or a note when the model cannot see. */

import { fileURLToPath } from "node:url";
import { Effect, FileSystem, Option } from "effect";
import { Prompt } from "effect/ai";

const NO_VISION = "[This model cannot see images, so the picture is left out.]";
const UNREADABLE = "[The picture file cannot be read.]";

/** The path of a saved picture, or nothing for any other part. */
const savedPath = (part: Prompt.UserMessagePart) =>
  part.type === "file" && part.data instanceof URL && part.data.protocol === "file:"
    ? Option.some(fileURLToPath(part.data))
    : Option.none();

/**
 * The prompt holds each picture as a file part with the file URL of its saved copy. With a model
 * that can see, each becomes the file's bytes; otherwise a text note. A file that is gone gives a
 * note too, so one lost file never fails a run.
 */
export const resolveImages = Effect.fn("resolveImages")(function* (
  prompt: Prompt.Prompt,
  options: { readonly canSeeImages: boolean },
) {
  const fileSystem = yield* FileSystem.FileSystem;

  const readPicture = (path: string, mediaType: string) =>
    fileSystem.readFile(path).pipe(
      Effect.option,
      Effect.map(
        Option.match({
          onNone: () => Prompt.textPart({ text: UNREADABLE }),
          onSome: (bytes) => Prompt.filePart({ mediaType, data: bytes }),
        }),
      ),
    );

  const resolvePart = (part: Prompt.UserMessagePart): Effect.Effect<Prompt.UserMessagePart> => {
    if (part.type !== "file") return Effect.succeed(part);

    return Option.match(savedPath(part), {
      onNone: () => Effect.succeed(part),
      onSome: (path) =>
        options.canSeeImages
          ? readPicture(path, part.mediaType)
          : Effect.succeed(Prompt.textPart({ text: NO_VISION })),
    });
  };

  const resolveMessage = (message: Prompt.Message): Effect.Effect<Prompt.Message> =>
    message.role === "user"
      ? Effect.forEach(message.content, resolvePart).pipe(
          Effect.map((content) => Prompt.userMessage({ content, options: message.options })),
        )
      : Effect.succeed(message);

  return Prompt.fromMessages(yield* Effect.forEach(prompt.content, resolveMessage));
});
