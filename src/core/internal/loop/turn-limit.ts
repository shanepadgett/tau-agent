/** Ends the run when `maxTurns` is set and the model has used that many turns since the prompt. */

import { Effect, Option } from "effect";
import type { Entry } from "../../../session/Entry.ts";
import { endWith, type Operation, type RunContext } from "./run-context.ts";
import { needsReply } from "./tool-history.ts";

const TURN_LIMIT = endWith({ reason: "turn-limit" });

export const stopAtTurnLimit =
  <R>(run: RunContext<R>): Operation<R> =>
  (entries) => {
    if (run.maxTurns === undefined || !needsReply(entries)) return Option.none();
    if (turnsSincePrompt(entries) < run.maxTurns) return Option.none();
    return Option.some(Effect.succeed(TURN_LIMIT));
  };

const turnsSincePrompt = (entries: readonly Entry[]) => {
  const prompt = entries.findLastIndex(({ body }) => body.type === "user");
  return entries.slice(prompt + 1).filter(({ body }) => body.type === "assistant").length;
};
