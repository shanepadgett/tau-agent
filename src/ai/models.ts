/**
 * Gives Effect language models and decision models for a route and a model name. Tau signs each
 * request with the credential of the route.
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
import { Context, Effect, Layer } from "effect";
import type { DecisionModel, LanguageModel } from "effect/ai";
import { HttpClient, HttpClientRequest } from "effect/http";
import {
  Catalog,
  type ModelRef,
  type NoDecisionApi,
  type UnknownModel,
  type UnknownRoute,
} from "./Catalog.ts";
import { CredentialStore, type CredentialStoreError } from "./Credential.ts";
import type { ModelProfile } from "./ModelProfile.ts";
import { withMessagesDefaults } from "./internal/protocols/messages-defaults.ts";
import { openAiDecisionModel } from "./internal/protocols/openai-decisions.ts";
import { collectResponseStream } from "./internal/protocols/responses-stream.ts";
import { withStructuredOutput } from "./internal/protocols/structured-output.ts";
import type { ConversationId } from "./ConversationId.ts";
import {
  type CredentialUnavailable,
  credentialSigner,
  type RequestSigning,
  signRequests,
} from "./internal/signing/route-auth.ts";
import type { Route } from "./Routes.ts";

type ModelsError = UnknownRoute | UnknownModel | CredentialUnavailable | CredentialStoreError;

/**
 * Both methods check the credential first. A missing login fails here, before Tau sends a request.
 */
export class Models extends Context.Service<
  Models,
  {
    /** Requests carry `conversationId`. A call outside a session passes a new ID for each call. */
    readonly languageModel: (
      ref: ModelRef,
      conversationId: ConversationId,
    ) => Effect.Effect<LanguageModel.LanguageModel, ModelsError>;
    readonly decisionModel: (
      ref: ModelRef,
    ) => Effect.Effect<DecisionModel.DecisionModel, ModelsError | NoDecisionApi>;
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
    route: Route,
    request: Omit<RequestSigning, "claudeCodeVersion">,
  ) {
    const signing = { ...request, claudeCodeVersion: yield* catalog.claudeCodeVersion };
    yield* credentialSigner(route, signing);
    return yield* signRequests(route, signing);
  });

  const languageModel = Effect.fn("Models.languageModel")(function* (
    ref: ModelRef,
    conversationId: ConversationId,
  ) {
    const { route, profile } = yield* catalog.model(ref);
    const sign = yield* signedFor(route, { protocol: profile.protocol, conversationId });
    return withStructuredOutput(yield* chatModel(route, profile, sign), profile.supports);
  });

  const decisionModel = Effect.fn("Models.decisionModel")(function* (ref: ModelRef) {
    const { route } = yield* catalog.decisionModel(ref);
    const sign = yield* signedFor(route, { protocol: route.protocol, conversationId: undefined });
    return yield* decisionModelFor(route, ref.model, sign);
  });

  return Models.of({
    languageModel: (ref, conversationId) =>
      languageModel(ref, conversationId).pipe(Effect.provideContext(context)),
    decisionModel: (ref) => decisionModel(ref).pipe(Effect.provideContext(context)),
  });
});

const chatModel = (route: Route, profile: ModelProfile, sign: ClientTransform) => {
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
            apiUrl: anthropicApiUrl(route.apiUrl),
            transformClient: (client) => withMessagesDefaults(sign(client)),
          }),
        ),
      );

    case "openaiResponses": {
      // The ChatGPT plan routes refuse requests that do not stream.
      const isStreamOnly = route.auth.kind === "codexLogin" || route.auth.kind === "chatgptApp";

      const transformClient = isStreamOnly
        ? (client: HttpClient.HttpClient) => collectResponseStream(sign(client))
        : sign;

      // Tau sends the full conversation in each request, so the server stores nothing. The server
      // returns reasoning in encrypted form, and Tau sends it back in the next request.
      return OpenAiLanguageModel.make({
        model,
        config: { store: false, include: ["reasoning.encrypted_content"] },
      }).pipe(
        Effect.provideServiceEffect(
          OpenAiClient.OpenAiClient,
          OpenAiClient.make({ apiUrl: route.apiUrl, transformClient }),
        ),
      );
    }

    case "openaiChat":
      return CompatLanguageModel.make({ model }).pipe(
        Effect.provideServiceEffect(
          CompatClient.OpenAiClient,
          CompatClient.make({ apiUrl: route.apiUrl, transformClient: sign }),
        ),
      );

    case "openrouter":
      // Without strict schemas, some upstream providers ignore the schema and reply in prose.
      return OpenRouterLanguageModel.make({ model, config: { strictJsonSchema: true } }).pipe(
        Effect.provideServiceEffect(
          OpenRouterClient.OpenRouterClient,
          OpenRouterClient.make({ apiUrl: route.apiUrl, transformClient: sign }),
        ),
      );
  }
};

/**
 * The Effect Anthropic client adds `/v1/messages` to the address. Some routes also serve OpenAI
 * protocols and keep `/v1` at the end of their address, for example OpenCode Go. Remove it here.
 */
const anthropicApiUrl = (apiUrl: string) => apiUrl.replace(/\/v1$/, "");

const decisionModelFor = Effect.fn("decisionModelFor")(function* (
  route: Route,
  model: string,
  sign: ClientTransform,
) {
  switch (route.decisions?.kind) {
    // The catalog refuses a route that has no decision API, so this does not occur.
    case undefined:
      return yield* Effect.die(`${route.id} has no decision API`);

    case "systemOne": {
      const transformClient = (client: HttpClient.HttpClient) => toSystemOne(sign(client));
      const client = yield* OpenRouterClient.make({ apiUrl: route.apiUrl, transformClient });

      return yield* OpenRouterDecisionModel.make({ model }).pipe(
        Effect.provideService(OpenRouterClient.OpenRouterClient, client),
      );
    }

    case "openaiDecisions": {
      const client = sign(
        (yield* HttpClient.HttpClient).pipe(
          HttpClient.mapRequest(HttpClientRequest.prependUrl(route.apiUrl)),
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
