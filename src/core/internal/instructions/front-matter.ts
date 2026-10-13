/**
 * Splits the YAML front matter of a Markdown file from its body and checks it with a schema. Used
 * for instruction files and skills.
 */

import { Effect, Option, type PlatformError, Schema } from "effect";

/** The front matter is the text between a first line of `---` and the next line of `---`. */
const FRONT_MATTER = /^---\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/;

class FrontMatterInvalid extends Schema.TaggedError<FrontMatterInvalid>()("FrontMatterInvalid", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export type MarkdownFile<A> = { readonly header: A; readonly body: string };

export const readFrontMatter = Effect.fn("readFrontMatter")(function* <A>(
  schema: Schema.Decoder<A>,
  text: string,
): Effect.fn.Return<MarkdownFile<A>, FrontMatterInvalid> {
  const match = FRONT_MATTER.exec(text);

  if (match === null) {
    return yield* new FrontMatterInvalid({
      message: "has no front matter between two lines of ---",
    });
  }

  const parsed = yield* Effect.try({
    try: () => Bun.YAML.parse(match[1] ?? ""),
    catch: (cause) =>
      new FrontMatterInvalid({ message: "has front matter that is not valid YAML", cause }),
  });

  const header = yield* Schema.decodeUnknownEffect(schema)(parsed ?? {}).pipe(
    Effect.mapError(
      (cause) =>
        new FrontMatterInvalid({
          message: `has a wrong value in its front matter: ${cause.message}`,
          cause,
        }),
    ),
  );

  return { header, body: text.slice(match[0].length).trim() };
});

/** Logs why a file was skipped, such as "the skill /a/b" and "it has no description", and gives none. */
export const skipped = <A>(what: string, reason: string) =>
  Effect.logWarning(`Skipped ${what}: ${reason}.`).pipe(Effect.as(Option.none<A>()));

/**
 * Skips a file with bad front matter, or one that cannot be read, with a warning. `subject` starts
 * the front matter reason, such as "it" or "its SKILL.md".
 */
export const skipUnreadable =
  <A>(what: string, subject: string) =>
  <R>(read: Effect.Effect<Option.Option<A>, FrontMatterInvalid | PlatformError.PlatformError, R>) =>
    read.pipe(
      Effect.catchTags({
        FrontMatterInvalid: (error) => skipped<A>(what, `${subject} ${error.message}`),
        PlatformError: (error) => skipped<A>(what, `it cannot be read: ${error.message}`),
      }),
    );
