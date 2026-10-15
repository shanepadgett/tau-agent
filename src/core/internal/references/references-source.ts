/** The references a session has attached, kept as session entries and told to the model as an instruction source. */

import { Effect, Option } from "effect";
import type { Entry } from "../../../session/Entry.ts";
import type { SessionNotFound } from "../../../session/Sessions.ts";
import type { SessionStoreError } from "../../../session/SessionStoreError.ts";
import type { InstructionSource } from "../instructions/instructions.ts";

const REFERENCES_KEY = "tau/references";

/** The names in the newest `references` entry of the session. */
const attachedNames = (entries: readonly Entry[]): readonly string[] => {
  const latest = entries.findLast(({ body }) => body.type === "references")?.body;
  return latest?.type === "references" ? latest.names : [];
};

/**
 * The attached references that still have a folder. A reference deleted from disk drops out of what
 * the model reads.
 */
export const referencesSource = (
  folder: string,
  library: readonly string[],
  entries: readonly Entry[],
): InstructionSource<never, never> => {
  const names = attachedNames(entries).filter((name) => library.includes(name));

  return {
    key: REFERENCES_KEY,
    read: Effect.succeed(names.length === 0 ? Option.none() : Option.some(names.join(", "))),
    first: (value) =>
      [
        `Reference repositories are read-only git clones in ${folder}/<name>.`,
        "When the user names one, read it there. Never change them.",
        `Attached: ${value}`,
      ].join("\n"),
    changed: (value) =>
      [
        `Reference repositories are read-only git clones in ${folder}/<name>.`,
        "When the user names one, read it there. Never change them.",
        `Attached now: ${value}`,
      ].join("\n"),
    removed: "No reference repositories are attached any more.",
  };
};

/** What a client does with the references of one open session. */
export type SessionReferences = {
  /** Saves `names` as the attached references and tells the session's clients. */
  readonly set: (
    names: readonly string[],
  ) => Effect.Effect<void, SessionNotFound | SessionStoreError>;
};
