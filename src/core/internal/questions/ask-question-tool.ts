/**
 * The `ask_question` tool, which the model has only on a run the user started with `/qna`. A valid
 * call ends the run, and the client shows the questions in a panel.
 */

import { Effect, Result, Schema } from "effect";
import { Tool } from "effect/ai";
import {
  AskQuestionParameters,
  recommendationProblem,
  repeatedQuestionId,
} from "../../../session/Questions.ts";
import type { ToolCall } from "../loop/tool-history.ts";
import type { ModelTool, ToolOutcome } from "../tools/model-tool.ts";

const DESCRIPTION = [
  "Puts questions to the user in a panel. Use it only on a /qna run, to ask again the questions you still need answered, and only when a missing preference or constraint would change your next step.",
  "",
  "Each question has an id and a prompt, and one kind:",
  "- select: the user picks one of 2 or more options, or types their own answer. Give each option a short label and, when it helps, a description.",
  "- confirm: the user answers Yes or No.",
  "- input: the user types an answer.",
  "",
  "A question may carry a recommendation: the answer you suggest and the reason for it. A recommendation needs a reason. For select and confirm, the answer is the label of one option (Yes or No for confirm); for input, it is the text you suggest.",
  "",
  "A valid call ends your turn. The user's answers arrive as their next message, so write nothing after the call.",
].join("\n");

const SEEN_BY_USER =
  "The questions are in front of the user. Stop here; their answers arrive as their next message.";

export const askQuestionTool: ModelTool<never> = {
  definition: Tool.dynamic("ask_question", {
    description: DESCRIPTION,
    parameters: Tool.getJsonSchemaFromSchema(AskQuestionParameters),
    success: Schema.String,
  }).annotate(Tool.Strict, false),

  call: (call) => Effect.succeed(askedQuestions(call)),
};

const askedQuestions = (call: ToolCall): ToolOutcome => {
  const parsed = Schema.decodeUnknownResult(AskQuestionParameters)(call.params);

  if (Result.isFailure(parsed))
    return rejected(`The questions are wrong: ${parsed.failure.message}`);

  const { questions } = parsed.success;
  const repeated = repeatedQuestionId(questions);

  if (repeated !== undefined)
    return rejected(`Two questions have the id "${repeated}". Give each its own id.`);

  const problem = recommendationProblem(questions);
  if (problem !== undefined) return rejected(problem);

  return {
    text: SEEN_BY_USER,
    isFailure: false,
    details: { tool: "ask_question", questions },
  };
};

const rejected = (text: string): ToolOutcome => ({ text, isFailure: true, details: undefined });
