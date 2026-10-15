/**
 * Keeps what the model knows about its surroundings current, such as instruction files and the date.
 */

// Before each model call Tau reads every source and saves the values that changed, as rendered
// text. The first reading goes in the system prompt; later changes go in the chat as updates, so the
// cached start of each request never changes.

import { Effect, Option } from "effect";
import type { Entry, EntryBody } from "../../../session/Entry.ts";
import { FileProblems } from "./file-problems.ts";

export type InstructionSource<E, R> = {
  readonly key: string;
  /** None if the source has no value, such as a file that does not exist. */
  readonly read: Effect.Effect<Option.Option<string>, E, R>;
  readonly first: (value: string) => string;
  readonly changed: (value: string, previous: string) => string;
  readonly removed: string;
};

type Values = Readonly<Record<string, string | null>>;

/** The value of each source after the saved entries. A source not in the result was never read. */
export const savedValues = (entries: readonly Entry[]): Values =>
  Object.fromEntries(
    entries.flatMap(({ body }) =>
      body.type === "instructions" ? Object.entries(body.values) : [],
    ),
  );

/**
 * Reads every source, and gives the entry to save, or none if nothing changed. A source that fails
 * keeps its saved value, so a failed read never looks like a removed file.
 */
export const instructionsUpdate = Effect.fn("instructionsUpdate")(function* <
  E extends { readonly message: string },
  R,
>(sources: readonly InstructionSource<E, R>[], entries: readonly Entry[]) {
  const saved = savedValues(entries);

  const current: Values = Object.fromEntries(
    yield* Effect.forEach(sources, (source) =>
      source.read.pipe(
        Effect.map((value) => [source.key, Option.getOrNull(value)] as const),
        Effect.catch((error) =>
          FileProblems.use((problems) =>
            problems.report(
              source.key,
              `Could not read ${source.key}, so the model keeps what it read before: ${error.message}`,
            ),
          ).pipe(Effect.as([source.key, saved[source.key] ?? null] as const)),
        ),
      ),
    ),
  );

  const isFirst = !entries.some(({ body }) => body.type === "instructions");
  return isFirst ? Option.some(firstEntry(sources, current)) : noteEntry(sources, saved, current);
});

/** The paths in the saved keys that start with `prefix`, such as `agents:` for agents files. */
export const savedPaths = (entries: readonly Entry[], prefix: string) =>
  Object.keys(savedValues(entries)).flatMap((key) =>
    key.startsWith(prefix) ? [key.slice(prefix.length)] : [],
  );

/** A source whose value is the instructions in the file at `path`, shown inside a tag that names the path. */
export const fileSource = <E, R>(
  key: string,
  path: string,
  read: Effect.Effect<Option.Option<string>, E, R>,
): InstructionSource<E, R> => ({
  key,
  read,
  first: (value) => tagged(path, value),
  changed: (value) => `${path} changed. It now says:\n${tagged(path, value)}`,
  removed: `The instructions from ${path} no longer apply.`,
});

const tagged = (path: string, value: string) =>
  `<instructions path="${path}">\n${value}\n</instructions>`;

const firstEntry = <E, R>(
  sources: readonly InstructionSource<E, R>[],
  current: Values,
): EntryBody => {
  const text = sources.flatMap((source) => {
    const value = current[source.key];
    return value === null || value === undefined ? [] : [source.first(value)];
  });

  return { type: "instructions", placement: "system", values: current, text: text.join("\n\n") };
};

const noteEntry = <E, R>(
  sources: readonly InstructionSource<E, R>[],
  saved: Values,
  current: Values,
): Option.Option<EntryBody> => {
  const changed = sources.filter(
    (source) => (current[source.key] ?? null) !== (saved[source.key] ?? null),
  );

  if (changed.length === 0) return Option.none();

  const values = Object.fromEntries(
    changed.map((source) => [source.key, current[source.key] ?? null]),
  );

  const text = changed.map((source) => changeText(source, saved[source.key], current[source.key]));

  return Option.some({
    type: "instructions",
    placement: "update",
    values,
    text: text.join("\n\n"),
  });
};

const changeText = <E, R>(
  source: InstructionSource<E, R>,
  previous: string | null | undefined,
  value: string | null | undefined,
) => {
  if (value === null || value === undefined) return source.removed;
  if (previous === null || previous === undefined) return source.first(value);
  return source.changed(value, previous);
};
