/**
 * Gives Effect language models and decision models for a provider and a model name. Tau signs each
 * request with the credential of the provider.
 */

import { AnthropicClient, AnthropicLanguageModel } from "@effect/ai-anthropic";
import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai";
import {
  OpenAiClient as CompatClient,
  OpenAiLanguageModel as CompatLanguageModel,
} from "@effect/ai-openai-compat";
import {
  OpenRouterClient,
  OpenRouterDecisionModel,
  OpenRouterLanguageModel,
} from "@effect/ai-openrouter";
import { Context, Effect, Layer, Option } from "effect";
import type { DecisionModel, LanguageModel } from "effect/ai";
import { HttpClient, HttpClientRequest } from "effect/http";
import {
  Catalog,
  type ListedModel,
  type ModelRef,
  type NoDecisionApi,
  type UnknownModel,
  type UnknownProvider,
} from "./Catalog.ts";
import { CredentialStore, type CredentialStoreError } from "./Credential.ts";
import {
  clampThinking,
  type ModelProfile,
  type ThinkingLevel,
  thinkingLevels,
} from "./ModelProfile.ts";
import { withMessagesDefaults } from "./internal/protocols/messages-defaults.ts";
import { openAiDecisionModel } from "./internal/protocols/openai-decisions.ts";
import { planOf, withPlanLimits } from "./internal/protocols/plan-limits.ts";
import { collectResponseStream } from "./internal/protocols/responses-stream.ts";
import { withStructuredOutput } from "./internal/protocols/structured-output.ts";
import { thinkingFields, withRequestFields } from "./internal/protocols/thinking.ts";
import type { ConversationId } from "./ConversationId.ts";
import {
  canCall,
  type CredentialUnavailable,
  credentialSigner,
  type RequestSigning,
  signRequests,
} from "./internal/signing/provider-auth.ts";
import type { Provider } from "./Providers.ts";

type ModelsError = UnknownProvider | UnknownModel | CredentialUnavailable | CredentialStoreError;

/**
 * Both methods check the credential first. A missing login fails here, before Tau sends a request.
 */
export class Models extends Context.Service<
  Models,
  {
    /**
     * Requests carry `conversationId`. A call outside a session passes a new ID for each call.
     * `thinking` moves to the nearest level the model offers; without it, the provider decides.
     */
    readonly languageModel: (
      ref: ModelRef,
      conversationId: ConversationId,
      thinking?: ThinkingLevel,
    ) => Effect.Effect<LanguageModel.LanguageModel, ModelsError>;
    readonly decisionModel: (
      ref: ModelRef,
    ) => Effect.Effect<DecisionModel.DecisionModel, ModelsError | NoDecisionApi>;
    /** The models of the providers that Tau can call now: logged in, with a key, or needing none. */
    readonly available: Effect.Effect<readonly ListedModel[], CredentialStoreError>;
    /** The context limit and prices of a model, to count what its calls use and cost. */
    readonly profile: (
      ref: ModelRef,
    ) => Effect.Effect<ModelProfile, UnknownProvider | UnknownModel>;
    /**
     * The cheap model of `ref`'s provider, for background notes, memory and `/commit`. It is `ref`
     * itself when the provider has none, or the catalog does not list it.
     */
    readonly smallModel: (ref: ModelRef) => Effect.Effect<ModelRef, UnknownProvider | UnknownModel>;
  }
>()("tau/ai/Models") {
  static readonly layer = Layer.effect(
    Models,
    Effect.suspend(() => makeModels()),
  );
}

type ClientTransform = (client: HttpClient.HttpClient) => HttpClient.HttpClient;

const makeModels = Effect.fn("makeModels")(function* () {
  const catalog = yield* Catalog;
  const context = yield* Effect.context<CredentialStore | HttpClient.HttpClient>();

  /** Checks the credential before Tau sends anything, then signs each request. */
  const signedFor = Effect.fn("signedFor")(function* (
    provider: Provider,
    request: Omit<RequestSigning, "claudeCodeVersion">,
  ) {
    const signing = { ...request, claudeCodeVersion: yield* catalog.claudeCodeVersion };
    yield* credentialSigner(provider, signing);
    return yield* signRequests(provider, signing);
  });

  const languageModel = Effect.fn("Models.languageModel")(function* (
    ref: ModelRef,
    conversationId: ConversationId,
    thinking: ThinkingLevel | undefined,
  ) {
    const { provider, profile } = yield* catalog.model(ref);
    const signed = yield* signedFor(provider, { protocol: profile.protocol, conversationId });
    const level = thinking && clampThinking(thinkingLevels(profile.thinking), thinking);
    const fields = level === undefined ? {} : thinkingFields(profile, level);
    const sign = (client: HttpClient.HttpClient) => withRequestFields(signed(client), fields);

    const chat = yield* chatModel(provider, profile, sign, conversationId);

    const limited = Option.match(planOf(provider.auth), {
      onNone: () => chat,
      onSome: (plan) => withPlanLimits(chat, plan),
    });

    return withStructuredOutput(limited, profile.supports);
  });

  const decisionModel = Effect.fn("Models.decisionModel")(function* (ref: ModelRef) {
    const { provider } = yield* catalog.decisionModel(ref);

    const sign = yield* signedFor(provider, {
      protocol: provider.protocol,
      conversationId: undefined,
    });

    return yield* decisionModelFor(provider, ref.model, sign);
  });

  const available = Effect.gen(function* () {
    const providers = yield* catalog.providerModels;
    const callable = yield* Effect.filter(providers, ({ provider }) => canCall(provider));
    return callable.flatMap(({ models }) => models);
  });

  return Models.of({
    available: available.pipe(Effect.provideContext(context)),
    profile: (ref) => catalog.model(ref).pipe(Effect.map(({ profile }) => profile)),
    languageModel: (ref, conversationId, thinking) =>
      languageModel(ref, conversationId, thinking).pipe(Effect.provideContext(context)),
    decisionModel: (ref) => decisionModel(ref).pipe(Effect.provideContext(context)),
    smallModel: (ref) => smallModel(catalog, ref),
  });
});

const smallModel = Effect.fn("smallModel")(function* (catalog: Catalog["Service"], ref: ModelRef) {
  const { provider } = yield* catalog.model(ref);
  if (provider.smallModel === undefined) return ref;
  const candidate: ModelRef = { provider: ref.provider, model: provider.smallModel };

  return yield* catalog.model(candidate).pipe(
    Effect.as(candidate),
    Effect.catchTag("UnknownModel", () => Effect.succeed(ref)),
  );
});

const chatModel = (
  provider: Provider,
  profile: ModelProfile,
  sign: ClientTransform,
  conversationId: ConversationId,
) => {
  const model = profile.id;

  switch (profile.protocol) {
    case "anthropic":
      // The catalog decides whether the model has native structured output. Effect guesses it from
      // Claude model names, and takes any other name as native.
      return AnthropicLanguageModel.make({
        model,
        config: { structuredOutputs: profile.supports.structuredOutput },
      }).pipe(
        Effect.provideServiceEffect(
          AnthropicClient.AnthropicClient,
          AnthropicClient.make({
            apiUrl: anthropicApiUrl(provider.apiUrl),
            transformClient: (client) => withMessagesDefaults(sign(client)),
          }),
        ),
      );

    case "openaiResponses": {
      // The ChatGPT plan providers refuse requests that do not stream.
      const isStreamOnly =
        provider.auth.kind === "codexLogin" || provider.auth.kind === "chatgptApp";

      const transformClient = isStreamOnly
        ? (client: HttpClient.HttpClient) => collectResponseStream(sign(client))
        : sign;

      // Tau sends the full conversation in each request, so the server stores nothing. The server
      // returns reasoning in encrypted form, and Tau sends it back in the next request. The cache
      // key sends each request of a conversation to the cache that holds its earlier requests.
      return OpenAiLanguageModel.make({
        model,
        config: {
          store: false,
          include: ["reasoning.encrypted_content"],
          prompt_cache_key: conversationId,
        },
      }).pipe(
        Effect.provideServiceEffect(
          OpenAiClient.OpenAiClient,
          OpenAiClient.make({ apiUrl: provider.apiUrl, transformClient }),
        ),
      );
    }

    case "openaiChat":
      return CompatLanguageModel.make({ model }).pipe(
        Effect.provideServiceEffect(
          CompatClient.OpenAiClient,
          CompatClient.make({ apiUrl: provider.apiUrl, transformClient: sign }),
        ),
      );

    case "openrouter":
      // Without strict schemas, some upstream providers ignore the schema and reply in prose.
      return OpenRouterLanguageModel.make({ model, config: { strictJsonSchema: true } }).pipe(
        Effect.provideServiceEffect(
          OpenRouterClient.OpenRouterClient,
          OpenRouterClient.make({ apiUrl: provider.apiUrl, transformClient: sign }),
        ),
      );
  }
};

/**
 * The Effect Anthropic client adds `/v1/messages` to the address. Some providers also serve OpenAI
 * protocols and keep `/v1` at the end of their address, for example OpenCode Go. Remove it here.
 */
const anthropicApiUrl = (apiUrl: string) => apiUrl.replace(/\/v1$/, "");

const decisionModelFor = Effect.fn("decisionModelFor")(function* (
  provider: Provider,
  model: string,
  sign: ClientTransform,
) {
  switch (provider.decisions?.kind) {
    // The catalog refuses a provider that has no decision API, so this does not occur.
    case undefined:
      return yield* Effect.die(`${provider.id} has no decision API`);

    case "systemOne": {
      const transformClient = (client: HttpClient.HttpClient) => toSystemOne(sign(client));
      const client = yield* OpenRouterClient.make({ apiUrl: provider.apiUrl, transformClient });

      return yield* OpenRouterDecisionModel.make({ model }).pipe(
        Effect.provideService(OpenRouterClient.OpenRouterClient, client),
      );
    }

    case "openaiDecisions": {
      const client = sign(
        (yield* HttpClient.HttpClient).pipe(
          HttpClient.mapRequest(HttpClientRequest.prependUrl(provider.apiUrl)),
        ),
      );

      return yield* openAiDecisionModel(client, model);
    }
  }
});

/**
 * Effect's OpenRouter decision model speaks TypeSafe's System One protocol, but posts to
 * `/api/alpha/decisions`, which returns 404. OpenRouter serves the same protocol at `/api/v1/systemone`.
 */
const toSystemOne = (client: HttpClient.HttpClient) =>
  HttpClient.mapRequest(client, (request) =>
    HttpClientRequest.setUrl(request, request.url.replace(/\/alpha\/decisions$/, "/v1/systemone")),
  );
