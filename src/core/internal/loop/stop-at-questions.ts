/** Ends the run when the model's last tool call put questions to the user. */

import { Effect, Option } from "effect";
import type { Entry } from "../../../session/Entry.ts";
import { endWith, type Operation } from "./run-context.ts";

/** The entries that follow a reply without being new input: tool calls and their bookkeeping. */
const isToolWork = ({ body }: Entry) =>
  body.type === "tool-started" ||
  body.type === "tool-result" ||
  body.type === "instructions" ||
  body.type === "nudge";

/**
 * Looks only at the tool work that follows the latest reply, so the run that carries the user's
 * answers does not stop on the questions it answers.
 */
export const stopAtQuestions: Operation<never> = (entries) => {
  const tail = entries.slice(entries.findLastIndex((entry) => !isToolWork(entry)) + 1);

  for (const { body } of tail) {
    if (body.type !== "tool-result" || body.isFailure) continue;
    if (body.details?.tool !== "ask_question") continue;

    return Option.some(
      Effect.succeed(endWith({ reason: "questions-asked", questions: body.details.questions })),
    );
  }

  return Option.none();
};
