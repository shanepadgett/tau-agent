/**
 * Gets structured output from every model that can call tools. Models without native structured
 * output answer through one forced tool call. An invalid answer gets one retry with the reason.
 */

import { Effect, Schema } from "effect";
import { AiError, LanguageModel, Prompt, Tool, Toolkit } from "effect/ai";
import type { Abilities } from "../../ModelProfile.ts";

/** Effect's default name for the object, when the caller gives none. */
const DEFAULT_OBJECT_NAME = "generateObject";

type ObjectRequest<S extends Schema.Top> = {
  readonly prompt: Prompt.RawInput;
  readonly schema: S;
  readonly objectName?: string | undefined;
  readonly toolkit?: object | undefined;
};

/** Replaces `generateObject` of `model`. The other methods do not change. */
export const withStructuredOutput = (
  model: LanguageModel.LanguageModel,
  supports: Abilities,
): LanguageModel.LanguageModel => {
  const generateObject: LanguageModel.LanguageModel["generateObject"] = (options) => {
    const attempt = (prompt: Prompt.RawInput): Effect.Effect<object, unknown, unknown> =>
      supports.structuredOutput
        ? model.generateObject({ ...options, prompt })
        : forcedTool(model, { ...options, prompt });

    const retried = attempt(options.prompt).pipe(
      Effect.catch((error) =>
        AiError.isAiError(error) && error.reason instanceof AiError.StructuredOutputError
          ? attempt(withFeedback(options.prompt, error.reason))
          : Effect.fail(error),
      ),
    );

    // SAFETY: both paths return Effect's own response for the caller's schema, fail only with
    // AiError, and need only the services of the caller's schema.
    return retried as never;
  };

  return { ...model, generateObject };
};

/**
 * Asks for the object as the parameters of one tool that the model must call. Effect checks
 * the parameters against the schema when it reads the reply.
 */
const forcedTool = Effect.fn("forcedTool")(function* <S extends Schema.Top>(
  model: LanguageModel.LanguageModel,
  request: ObjectRequest<S>,
) {
  if (request.toolkit !== undefined) {
    return yield* objectError(
      new AiError.InvalidUserInputError({
        description:
          "This model has no native structured output, so generateObject cannot also take tools.",
      }),
    );
  }

  const objectName = request.objectName ?? DEFAULT_OBJECT_NAME;
  const tool = Tool.make(objectName, { parameters: request.schema });

  const response = yield* model
    .generateText({
      prompt: request.prompt,
      toolkit: Toolkit.make(tool),
      toolChoice: { tool: objectName },
      disableToolCallResolution: true,
    })
    .pipe(Effect.mapError(asStructuredOutputError));

  const call = response.toolCalls.find((candidate) => candidate.name === objectName);

  if (call === undefined) {
    return yield* objectError(
      new AiError.StructuredOutputError({
        description: `The model did not call the ${objectName} tool.`,
        responseText: response.text,
      }),
    );
  }

  const value = yield* Schema.decodeUnknownEffect(request.schema)(call.params).pipe(
    Effect.catch((error) =>
      objectError(
        AiError.StructuredOutputError.fromSchemaError(error, JSON.stringify(call.params)),
      ),
    ),
  );

  return new LanguageModel.GenerateObjectResponse(value, response.content);
});

/**
 * Effect checks tool parameters when it reads the reply, and reports a mismatch as invalid output
 * from `LanguageModel`. A reply that the provider client cannot read has another module.
 */
const asStructuredOutputError = (error: AiError.AiError) => {
  const isParameterMismatch =
    error.module === "LanguageModel" && error.reason instanceof AiError.InvalidOutputError;

  if (!isParameterMismatch) return error;

  return AiError.make({
    module: "LanguageModel",
    method: "generateObject",
    reason: new AiError.StructuredOutputError({
      description: error.reason.description,
      responseText: "",
    }),
  });
};

const objectError = (reason: AiError.AiErrorReason) =>
  Effect.fail(AiError.make({ module: "LanguageModel", method: "generateObject", reason }));

/** The first prompt, then the invalid answer and the reason it is invalid. */
const withFeedback = (prompt: Prompt.RawInput, error: AiError.StructuredOutputError) => {
  const answer: Prompt.MessageEncoded[] =
    error.responseText === "" ? [] : [{ role: "assistant", content: error.responseText }];

  return Prompt.concat(Prompt.make(prompt), [
    ...answer,
    {
      role: "user",
      content: `That answer does not match the schema: ${error.description}\nAnswer again.`,
    },
  ]);
};
