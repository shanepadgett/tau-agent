/** What the operations of one run share, and the shape every operation has. */

import type { Effect, Option } from "effect";
import type { AiError, LanguageModel } from "effect/ai";
import type { ModelRef } from "../../../ai/Catalog.ts";
import type { Functions, Touched } from "../../../sandbox/Sandbox.ts";
import type { Entry, EntryBody, SessionId } from "../../../session/Entry.ts";
import type { SessionNotFound, Sessions, SessionStoreError } from "../../../session/Sessions.ts";
import type { AgentEvent } from "../../Client.ts";
import type { Timeouts } from "../run-tool/run-tool.ts";

export type Outcome =
  | { readonly type: "continue" }
  | { readonly type: "end"; readonly reason: "answered" | "turn-limit" | "output-limit" };

export const CONTINUE: Outcome = { type: "continue" };

export type RunContext<R> = {
  readonly session: SessionId;
  readonly model: ModelRef;
  readonly languageModel: LanguageModel.LanguageModel;
  readonly sessions: Sessions["Service"];
  /** The functions of one script; they report each file they touch to `touched`. */
  readonly functions: (touched: Touched) => Functions<R>;
  /** The instructions entry to save before the next model call, if any source changed. */
  readonly updateInstructions: (
    entries: readonly Entry[],
  ) => Effect.Effect<Option.Option<EntryBody>, never, R>;
  readonly timeouts: Timeouts;
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
