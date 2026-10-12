/** Answers Effect decision questions through OpenAI's Decisions API (`POST /v1/decisions`), which serves Luna. */

import { Effect, Match, Schema } from "effect";
import { AiError, type Decision, DecisionModel } from "effect/ai";
import { type HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

/** OpenAI reports probabilities to two decimals, so a distribution can be off by rounding. */
const PROBABILITY_DECIMALS = 2;

const HTTP_OK = 200;

const ChoiceAnswer = Schema.Struct({
  type: Schema.Literal("choice"),
  name: Schema.String,
  choice: Schema.String,
  probabilities: Schema.Array(Schema.Struct({ value: Schema.String, probability: Schema.Number })),
  confidence: Schema.Number,
});

const ScoreAnswer = Schema.Struct({
  type: Schema.Literal("score"),
  name: Schema.String,
  score: Schema.Number,
  probabilities: Schema.Array(Schema.Struct({ label: Schema.String, probability: Schema.Number })),
  confidence: Schema.Number,
});

const PredicateAnswer = Schema.Struct({
  type: Schema.Literal("predicate"),
  name: Schema.String,
  probability: Schema.Number,
});

type WireAnswer = typeof ChoiceAnswer.Type | typeof ScoreAnswer.Type | typeof PredicateAnswer.Type;

const DecisionsResponse = Schema.Struct({
  answers: Schema.Array(Schema.Union([ChoiceAnswer, ScoreAnswer, PredicateAnswer])),
  usage: Schema.Struct({ input_tokens: Schema.Number, output_tokens: Schema.Number }),
});

const ClassifyAnswer = Schema.TaggedStruct("Classify", {
  label: Schema.String,
  probabilities: Schema.Record(Schema.String, Schema.Number),
  confidence: Schema.Number,
});

const RateAnswer = Schema.TaggedStruct("Rate", {
  rating: Schema.Number,
  probabilities: Schema.Record(Schema.String, Schema.Number),
  confidence: Schema.Number,
});

const ProbabilityAnswer = Schema.TaggedStruct("Probability", { probability: Schema.Number });

/** The API reads the state as text. */
const encodeState = Schema.encodeSync(Schema.fromJsonString(Schema.Json));

/** `client` already carries the API URL and the API key. */
export const openAiDecisionModel = (client: HttpClient.HttpClient, model: string) =>
  DecisionModel.make({
    probabilityPrecision: PROBABILITY_DECIMALS,
    decide: ({ state, decisions }) =>
      Effect.gen(function* () {
        const questions = Object.entries(decisions).map(([name, decision]) =>
          question(name, decision),
        );

        const request = HttpClientRequest.bodyJsonUnsafe(HttpClientRequest.post("/decisions"), {
          model,
          input: encodeState(state),
          questions,
        });

        const response = yield* client.execute(request);
        if (response.status !== HTTP_OK) return yield* rejected(response);
        const body = yield* HttpClientResponse.schemaBodyJson(DecisionsResponse)(response);

        return {
          answers: Object.fromEntries(
            body.answers.map((answer) => [answer.name, providerAnswer(answer)]),
          ),
          usage: { inputTokens: body.usage.input_tokens, outputTokens: body.usage.output_tokens },
        };
      }).pipe(
        Effect.catchTags({
          HttpClientError: (error) =>
            Effect.fail(decideError(new AiError.UnknownError({ description: error.message }))),
          SchemaError: (error) =>
            Effect.fail(
              decideError(new AiError.InvalidOutputError({ description: error.message })),
            ),
        }),
      ),
  });

const question = (name: string, decision: Decision.Any) =>
  Match.valueTags(decision, {
    Classify: ({ instructions, criteria }) => ({
      type: "choice",
      name,
      instructions,
      choices: Object.entries(criteria).map(([value, description]) => ({ value, description })),
    }),
    Rate: ({ instructions, criteria }) => ({
      type: "score",
      name,
      instructions,
      levels: criteria.map((label) => ({ label })),
    }),
    // The API has no field for what each answer means, so it goes in the instructions.
    Probability: ({ instructions, criteria }) => ({
      type: "predicate",
      name,
      instructions:
        criteria === undefined
          ? instructions
          : `${instructions}\n\nTrue means: ${criteria.true}\nFalse means: ${criteria.false}`,
    }),
  });

const providerAnswer = (answer: WireAnswer): DecisionModel.ProviderAnswer => {
  switch (answer.type) {
    case "choice":
      return ClassifyAnswer.make({
        label: answer.choice,
        probabilities: Object.fromEntries(
          answer.probabilities.map((entry) => [entry.value, entry.probability]),
        ),
        confidence: answer.confidence,
      });
    case "score":
      return RateAnswer.make({
        rating: answer.score,
        probabilities: Object.fromEntries(
          answer.probabilities.map((entry) => [entry.label, entry.probability]),
        ),
        confidence: answer.confidence,
      });
    case "predicate":
      return ProbabilityAnswer.make({ probability: answer.probability });
  }
};

const rejected = (response: HttpClientResponse.HttpClientResponse) =>
  response.text.pipe(
    Effect.flatMap((body) =>
      Effect.fail(
        decideError(AiError.reasonFromHttpStatus({ status: response.status, description: body })),
      ),
    ),
  );

const decideError = (reason: AiError.AiErrorReason) =>
  AiError.make({ module: "OpenAiDecisions", method: "decide", reason });
