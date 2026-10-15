/** Shared by notes and memory: generates a non-empty summary. */

import { Effect } from "effect";
import { AiError, type LanguageModel, Prompt } from "effect/ai";
import type { Models } from "../../../../ai/Models.ts";
import type { Notes } from "../../../../session/Notes.ts";

export type SummaryServices = {
  readonly notes: Notes["Service"];
  readonly models: Models["Service"];
};

export const summarize = Effect.fn("summarize")(function* (
  languageModel: LanguageModel.LanguageModel,
  rules: string,
  input: string,
) {
  const response = yield* languageModel.generateText({
    prompt: Prompt.fromMessages([
      Prompt.systemMessage({ content: rules }),
      Prompt.userMessage({ content: [Prompt.textPart({ text: input })] }),
    ]),
  });

  if (response.text.trim() === "")
    return yield* AiError.make({
      module: "ContextMethod",
      method: "summarize",
      reason: new AiError.InvalidOutputError({
        description: "The summary model returned an empty summary.",
      }),
    });

  return response.text;
});
