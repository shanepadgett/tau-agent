/** What the operations of one run share, and the shape every operation has. */

import type { Effect, Option } from "effect";
import type { AiError, LanguageModel, Prompt } from "effect/ai";
import type { ModelRef } from "../../../ai/Catalog.ts";
import type { ModelProfile } from "../../../ai/ModelProfile.ts";
import type { Entry, EntryBody, NudgeEntry, SessionId } from "../../../session/Entry.ts";
import type { SessionNotFound, Sessions } from "../../../session/Sessions.ts";
import type { SessionStoreError } from "../../../session/SessionStoreError.ts";
import type { AgentEvent, RunEnd } from "../../Client.ts";
import type { ProjectChecks } from "../checks/checks-file.ts";
import type { ModelTool } from "../tools/model-tool.ts";

export type Outcome =
  | { readonly type: "continue" }
  | { readonly type: "end"; readonly end: RunEnd };

export const CONTINUE: Outcome = { type: "continue" };

export const endWith = (end: RunEnd): Outcome => ({ type: "end", end });

export type RunContext<R> = {
  readonly session: SessionId;
  readonly model: ModelRef;
  /** The model's context limit and prices, to report what each model call used and cost. */
  readonly profile: ModelProfile;
  readonly languageModel: LanguageModel.LanguageModel;
  readonly sessions: Sessions["Service"];
  /** The tools the model can call. */
  readonly tools: readonly ModelTool<R>[];
  readonly view: (
    soul: string,
    entries: readonly Entry[],
  ) => Effect.Effect<Prompt.Prompt, SessionStoreError>;
  readonly nudge: (entries: readonly Entry[]) => Option.Option<NudgeEntry>;
  readonly contextOperations: readonly Operation<never>[];
  readonly shouldReply: (entries: readonly Entry[]) => boolean;
  /** The project's checks, read once at the start of the run. */
  readonly checks: Option.Option<ProjectChecks>;
  /** The instructions entry to save before the next model call, if any source changed. */
  readonly updateInstructions: (
    entries: readonly Entry[],
  ) => Effect.Effect<Option.Option<EntryBody>, never, R>;
  /** Notices to save before the next model call, such as a command that exited. */
  readonly processNotices: Effect.Effect<readonly NudgeEntry[]>;
  /** The steering messages the user sent since the last model call. Taking them empties the list. */
  readonly takeSteering: Effect.Effect<readonly string[]>;
  /** A steering message's entry, then the listings of the folders it tags. */
  readonly withListings: (
    user: Extract<EntryBody, { type: "user" }>,
  ) => Effect.Effect<readonly EntryBody[], never, R>;
  readonly maxTurns: number | undefined;
  readonly emit: (event: AgentEvent) => Effect.Effect<void>;
};

export type RunError = SessionNotFound | SessionStoreError | AiError.AiError;

/**
 * Looks at the session's entries and passes with none, or gives the action to take. An operation
 * keeps nothing in memory: what it did is in the entries it saves.
 */
export type Operation<R> = (
  entries: readonly Entry[],
) => Option.Option<Effect.Effect<Outcome, RunError, R>>;
