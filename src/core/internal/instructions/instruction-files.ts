/**
 * Finds instruction files, the Markdown files in `.tau/instructions` folders, and gives their
 * instruction sources: each "always" file, and the list of files to read when their situation applies.
 */

import { basename, join } from "node:path";
import { Effect, FileSystem, Option, Schema } from "effect";
import type { Entry } from "../../../session/Entry.ts";
import { readFrontMatter, reportSkipped, skipped, skipUnreadable } from "./front-matter.ts";
import { fileSource, type InstructionSource, savedPaths } from "./instructions.ts";

const INSTRUCTIONS_KEY = "instructions:";
const MARKDOWN = ".md";

const InstructionHeader = Schema.Struct({
  always: Schema.optional(Schema.Boolean),
  "read-when": Schema.optional(Schema.String),
});

/** When the model reads an instruction file. */
type ReadWhen =
  | { readonly type: "always" }
  | { readonly type: "read-when"; readonly situation: string };

export type InstructionFile = {
  /** The file name without `.md`. */
  readonly name: string;
  readonly path: string;
  /** The text after the front matter. */
  readonly body: string;
  readonly when: ReadWhen;
};

/**
 * The instruction files in `folders`, most shared first. A file in a later folder replaces one of
 * the same name, so the folder closest to the session directory wins. A file that cannot be read
 * or has wrong front matter is skipped with a warning.
 */
export const findInstructionFiles = Effect.fn("findInstructionFiles")(function* (
  folders: readonly string[],
) {
  const found = yield* Effect.forEach(folders, filesIn);
  const byName = new Map(found.flat().map((file) => [file.name, file]));
  return [...byName.values()];
});

const filesIn = Effect.fn("filesIn")(
  function* (folder: string) {
    const fileSystem = yield* FileSystem.FileSystem;
    if (!(yield* fileSystem.exists(folder))) return [];

    const names = (yield* fileSystem.readDirectory(folder))
      .filter((name) => name.endsWith(MARKDOWN))
      .toSorted();

    const files = yield* Effect.forEach(names, (name) => readInstructionFile(join(folder, name)));
    return files.flatMap(Option.toArray);
  },
  (found, folder) =>
    found.pipe(
      Effect.catch((error) =>
        reportSkipped(`the instruction files in ${folder}`, error.message).pipe(
          Effect.as<readonly InstructionFile[]>([]),
        ),
      ),
    ),
);

const readInstructionFile = (path: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;

    const { header, body } = yield* readFrontMatter(
      InstructionHeader,
      yield* fileSystem.readFileString(path),
    );

    const when = readWhen(header);

    if (Option.isNone(when)) {
      return yield* skipped<InstructionFile>(
        `the instruction file ${path}`,
        'its front matter needs "always: true" or "read-when"',
      );
    }

    const file: InstructionFile = { name: basename(path, MARKDOWN), path, body, when: when.value };
    return Option.some(file);
  }).pipe(skipUnreadable<InstructionFile>(`the instruction file ${path}`, "it"));

const readWhen = (header: typeof InstructionHeader.Type): Option.Option<ReadWhen> => {
  if (header.always === true) return Option.some({ type: "always" });
  const situation = header["read-when"]?.trim() ?? "";
  return situation === "" ? Option.none() : Option.some({ type: "read-when", situation });
};

/**
 * A source for each "always" file, and for each one saved before. A file that is no longer an
 * "always" file reads as removed.
 */
export const alwaysSources = (files: readonly InstructionFile[], entries: readonly Entry[]) => {
  const always = new Map(
    files.flatMap((file) => (file.when.type === "always" ? [[file.path, file.body] as const] : [])),
  );

  const paths = new Set([...always.keys(), ...savedPaths(entries, INSTRUCTIONS_KEY)]);

  return [...paths].map((path) =>
    fileSource(
      `${INSTRUCTIONS_KEY}${path}`,
      path,
      Effect.succeed(Option.fromUndefinedOr(always.get(path))),
    ),
  );
};

/** The list of files the model reads when their situation applies. */
export const readWhenSource = (
  files: readonly InstructionFile[],
): InstructionSource<never, never> => {
  const lines = files.flatMap(({ name, path, when }) =>
    when.type === "read-when" ? [`- ${name} (${path}): ${when.situation}`] : [],
  );

  return {
    key: "tau/instruction-files",
    read: Effect.succeed(lines.length === 0 ? Option.none() : Option.some(lines.join("\n"))),
    first: (value) => `Read an instruction file when its situation applies:\n${value}`,
    changed: (value) =>
      `The instruction files to read when their situation applies are now:\n${value}`,
    removed: "There are no longer instruction files to read when their situation applies.",
  };
};
