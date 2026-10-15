/**
 * `/commit`: the steps that turn every changed file into commits, with no screen code. A client
 * runs them in order: start, check, plan, commit, then push.
 */

import { Context, type Effect, type Option, Schema } from "effect";
import type { ModelRef } from "../ai/Catalog.ts";
import type { ChangedFile } from "../workspace/Git.ts";

/** Where a push goes, such as `origin/main`; `isNew` when the branch has no upstream yet. */
export type PushTarget = {
  readonly name: string;
  readonly isNew: boolean;
  readonly branch: string;
};

/** `commit` in `~/.tau/settings.json`. */
export type CommitSettings = {
  /** `ask` asks after each `/commit`, with No first. */
  readonly push: "ask" | boolean;
  /** Plans no breaking-change commits. */
  readonly avoidBreakingChanges: boolean;
};

export const CommitSettings = Context.Reference<CommitSettings>("tau/core/CommitSettings", {
  defaultValue: () => ({ push: "ask", avoidBreakingChanges: false }),
});

export class CommitError extends Schema.TaggedError<CommitError>()("CommitError", {
  message: Schema.String,
}) {}

/** Some commits were made before one failed. */
export class CommitFailed extends Schema.TaggedError<CommitFailed>()("CommitFailed", {
  hashes: Schema.Array(Schema.String),
  message: Schema.String,
}) {}

/** The repository and its changed files when `/commit` started. */
export type CommitStart = {
  readonly root: string;
  readonly files: readonly ChangedFile[];
};

/**
 * `failed` gives the prompt that asks the agent to fix the checks. `changed` means a check
 * changed files, so the user should look before committing.
 */
export type CommitChecks =
  | { readonly type: "passed" }
  | { readonly type: "failed"; readonly names: readonly string[]; readonly prompt: string }
  | { readonly type: "changed" };

export type PlannedCommit = { readonly message: string; readonly files: readonly ChangedFile[] };

export type Commits = {
  readonly settings: CommitSettings;
  /** None when the session's folder is not in a repository; no files when nothing changed. */
  readonly start: Effect.Effect<Option.Option<CommitStart>, CommitError>;
  /** The number of checks that apply, then their outcome. */
  readonly checkCount: (start: CommitStart) => Effect.Effect<number, CommitError>;
  readonly check: (start: CommitStart) => Effect.Effect<CommitChecks, CommitError>;
  /** The model that plans: the small model of `chatModel`'s provider. */
  readonly planModel: (chatModel: ModelRef) => Effect.Effect<ModelRef, CommitError>;
  /** `instruction` is the text after `/commit`, or empty. */
  readonly plan: (
    start: CommitStart,
    model: ModelRef,
    instruction: string,
  ) => Effect.Effect<readonly PlannedCommit[], CommitError>;
  /** Commits each group in order, and gives their short hashes. `onCommit` gets each index. */
  readonly commit: (
    start: CommitStart,
    plan: readonly PlannedCommit[],
    onCommit: (index: number) => void,
  ) => Effect.Effect<readonly string[], CommitFailed>;
  readonly pushTarget: (
    start: CommitStart,
  ) => Effect.Effect<Option.Option<PushTarget>, CommitError>;
  readonly push: (start: CommitStart, target: PushTarget) => Effect.Effect<void, CommitError>;
};
