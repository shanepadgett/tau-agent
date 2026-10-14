/** Shared by notes and memory: picks the summary model and generates a non-empty summary. */

import { Effect } from "effect";
import { AiError, type LanguageModel, Prompt } from "effect/ai";
import type { Catalog, ModelRef } from "../../../../ai/Catalog.ts";
import type { Models } from "../../../../ai/Models.ts";
import type { Notes } from "../../../../session/Notes.ts";

export type SummaryServices = {
  readonly notes: Notes["Service"];
  readonly catalog: Catalog["Service"];
  readonly models: Models["Service"];
};

export const summaryModel = Effect.fn("summaryModel")(function* (
  catalog: Catalog["Service"],
  current: ModelRef,
) {
  const { route } = yield* catalog.model(current);
  if (route.noteModel === undefined) return current;
  const candidate = { route: current.route, model: route.noteModel };

  return yield* catalog.model(candidate).pipe(
    Effect.as(candidate),
    Effect.catchTag("UnknownModel", () => Effect.succeed(current)),
  );
});

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
