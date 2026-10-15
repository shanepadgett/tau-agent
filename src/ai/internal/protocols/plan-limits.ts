/**
 * Turns the reply a plan login gets at its usage limit into a quota error. Effect does not retry
 * quota errors, and the error says when the plan resets.
 */

import { DateTime, Effect, Option, Schema, Stream } from "effect";
import { AiError, type LanguageModel } from "effect/ai";
import { PLAN_METADATA_KEY, type Plan } from "../../PlanLimit.ts";
import type { ProviderAuth } from "../../Providers.ts";

type HttpContext = typeof AiError.HttpContext.Type;

/** A plan, and how its replies show the usage limit. Some holds the reset time, if the reply has one. */
type PlanReader = {
  readonly plan: Plan;
  readonly limitIn: (
    http: HttpContext,
  ) => Option.Option<{ readonly resetAt: DateTime.Utc | undefined }>;
};

const TOO_MANY_REQUESTS = 429;

const ChatgptLimit = Schema.fromJsonString(
  Schema.Struct({
    error: Schema.Struct({
      type: Schema.Literal("usage_limit_reached"),
      resets_at: Schema.optional(Schema.Number),
    }),
  }),
);

const decodeChatgptLimit = Schema.decodeUnknownOption(ChatgptLimit);
const decodeSeconds = Schema.decodeUnknownOption(Schema.FiniteFromString);

/** ChatGPT names the limit in the body, as the Codex CLI reads it. */
const chatgptLimit = (http: HttpContext) =>
  http.response?.status === TOO_MANY_REQUESTS
    ? decodeChatgptLimit(http.body).pipe(
        Option.map(({ error }) => ({
          resetAt:
            error.resets_at === undefined ? undefined : DateTime.fromEpochSeconds(error.resets_at),
        })),
      )
    : Option.none();

/** Claude names the limit in the `anthropic-ratelimit-unified-*` headers. */
const claudeLimit = (http: HttpContext) => {
  const headers = http.response?.headers ?? {};

  return http.response?.status === TOO_MANY_REQUESTS &&
    headers["anthropic-ratelimit-unified-status"] === "rejected"
    ? Option.some({
        resetAt: decodeSeconds(headers["anthropic-ratelimit-unified-reset"]).pipe(
          Option.map(DateTime.fromEpochSeconds),
          Option.getOrUndefined,
        ),
      })
    : Option.none();
};

const CHATGPT: PlanReader = {
  plan: { name: "ChatGPT", usagePage: "https://chatgpt.com/settings/usage" },
  limitIn: chatgptLimit,
};

const CLAUDE: PlanReader = {
  plan: { name: "Claude", usagePage: "https://claude.ai/settings/usage" },
  limitIn: claudeLimit,
};

/** The plan of a subscription login. Other logins have no plan. */
export const planOf = (auth: ProviderAuth): Option.Option<PlanReader> => {
  switch (auth.kind) {
    case "claudeSubscription":
      return Option.some(CLAUDE);
    case "codexLogin":
    case "chatgptApp":
      return Option.some(CHATGPT);
    case "none":
    case "apiKey":
      return Option.none();
  }
};

/** The error to give for `error`: a quota error when it is the plan's usage limit, else `error`. */
const planLimitError =
  ({ plan, limitIn }: PlanReader) =>
  <E>(error: E): E | AiError.AiError => {
    if (!AiError.isAiError(error) || !(error.reason instanceof AiError.RateLimitError))
      return error;

    const { http } = error.reason;
    const limit = http === undefined ? Option.none() : limitIn(http);
    if (Option.isNone(limit)) return error;

    return AiError.make({
      module: error.module,
      method: error.method,
      reason: new AiError.QuotaExhaustedError({
        resetAt: limit.value.resetAt,
        http,
        metadata: { [PLAN_METADATA_KEY]: plan },
      }),
    });
  };

/** The model, with each usage-limit reply of its plan turned into a quota error. */
export const withPlanLimits = (
  model: LanguageModel.LanguageModel,
  reader: PlanReader,
): LanguageModel.LanguageModel => {
  const toLimit = planLimitError(reader);

  // SAFETY: each method gives the same value as the model's own, and only changes one AiError into
  // another AiError, which every method can already fail with.
  return {
    ...model,
    generateText: ((options: never) =>
      Effect.mapError(model.generateText(options), toLimit)) as never,
    generateObject: ((options: never) =>
      Effect.mapError(model.generateObject(options), toLimit)) as never,
    streamText: ((options: never) => Stream.mapError(model.streamText(options), toLimit)) as never,
  };
};
