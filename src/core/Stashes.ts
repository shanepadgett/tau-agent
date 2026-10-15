/** The prompts a user parks with Ctrl+S, kept per project folder until `/pop` takes one back. The CLI gives the database in Tau's home folder; a test gives a temporary one. */

import { Context, type DateTime, type Effect, Schema } from "effect";

/** A parked prompt. `id` names it for `remove`. */
export type Stash = {
  readonly id: number;
  readonly text: string;
  readonly createdAt: DateTime.Utc;
};

export class StashesError extends Schema.TaggedError<StashesError>()("StashesError", {
  path: Schema.String,
  cause: Schema.Defect(),
}) {}

export class Stashes extends Context.Service<
  Stashes,
  {
    /** The stashes of `project`, the latest first. */
    readonly list: (project: string) => Effect.Effect<readonly Stash[], StashesError>;
    /** Parks `text` for `project`. `duplicate` means the project already holds the same text. */
    readonly add: (
      project: string,
      text: string,
    ) => Effect.Effect<"stashed" | "duplicate", StashesError>;
    readonly remove: (id: number) => Effect.Effect<void, StashesError>;
  }
>()("tau/core/Stashes") {}
