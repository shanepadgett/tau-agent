/** The context behavior injected into one run: its view, tools, nudges and loop operations. */

import type { Effect, Option } from "effect";
import type { Prompt } from "effect/ai";
import type { Entry, NudgeEntry } from "../../../session/Entry.ts";
import type { SessionStoreError } from "../../../session/SessionStoreError.ts";
import type { Operation } from "../loop/run-context.ts";
import type { ModelTool } from "../tools/model-tool.ts";

export type RunMethod = {
  readonly view: (
    soul: string,
    entries: readonly Entry[],
  ) => Effect.Effect<Prompt.Prompt, SessionStoreError>;
  readonly tools: readonly ModelTool<never>[];
  readonly nudge: (entries: readonly Entry[]) => Option.Option<NudgeEntry>;
  readonly operations: readonly Operation<never>[];
  readonly shouldReply: (entries: readonly Entry[]) => boolean;
};
