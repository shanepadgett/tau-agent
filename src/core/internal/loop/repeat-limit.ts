/**
 * Ends the run when the model sent the same failing call several times in a row. Each of those
 * results already told the model what was wrong, so another try would only repeat it.
 */

import { Effect, Equal, Option } from "effect";
import type { Entry } from "../../../session/Entry.ts";
import { endWith, type Operation } from "./run-context.ts";
import { allCalls, needsReply, sincePrompt, summary, type ToolCall } from "./tool-history.ts";

const REPEAT_LIMIT = 3;

export const stopRepeatedCalls: Operation<never> = (entries) => {
  if (!needsReply(entries)) return Option.none();

  return Option.map(repeatedCall(entries), (call) =>
    Effect.succeed(endWith({ reason: "repeated-call", call: summary(call) })),
  );
};

/** The call, when the last results of the run are the same call failing each time. */
const repeatedCall = (entries: readonly Entry[]) => {
  const lastResults = sincePrompt(entries)
    .flatMap(({ body }) => (body.type === "tool-result" ? [body] : []))
    .slice(-REPEAT_LIMIT);

  if (lastResults.length < REPEAT_LIMIT || lastResults.some(({ isFailure }) => !isFailure))
    return Option.none();

  const calls = new Map(allCalls(entries).map((call) => [call.id, call]));
  const repeated = lastResults.map(({ callId }) => calls.get(callId));
  const [first] = repeated;
  if (first === undefined) return Option.none();

  const isSameCall = (call: ToolCall | undefined) =>
    call?.name === first.name && Equal.equals(call.params, first.params);

  return repeated.every(isSameCall) ? Option.some(first) : Option.none();
};
