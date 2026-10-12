/** Hands out Effect language and decision models by route and model name, signed per request with Tau's credentials. */

import { AnthropicClient, AnthropicLanguageModel } from "@effect/ai-anthropic";
import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai";
import {
  OpenRouterClient,
  OpenRouterDecisionModel,
  OpenRouterLanguageModel,
} from "@effect/ai-openrouter";
import { Context, Effect, Layer, Schema } from "effect";
import type { DecisionModel, LanguageModel } from "effect/ai";
import { HttpClient, HttpClientRequest } from "effect/http";
import { collectCodexStream } from "./codex.ts";
import { CredentialStore, type CredentialStoreError } from "./credential.ts";
import { openAiDecisionModel } from "./openai-decisions.ts";
import { type CredentialUnavailable, credentialSigner, signRequests } from "./route-auth.ts";
import { RouteId, type Route } from "./routes.ts";

type ModelRef = { readonly route: RouteId; readonly model: string };

class UnknownRoute extends Schema.TaggedError<UnknownRoute>()("UnknownRoute", {
  route: RouteId,
  message: Schema.String,
}) {}

class NoDecisionApi extends Schema.TaggedError<NoDecisionApi>()("NoDecisionApi", {
  route: RouteId,
  message: Schema.String,
}) {}

type ModelsError = UnknownRoute | NoDecisionApi | CredentialUnavailable | CredentialStoreError;

/** Both methods check the credential first, so a missing login fails here rather than mid-request. */
export class Models extends Context.Service<
  Models,
  {
    readonly languageModel: (
      ref: ModelRef,
    ) => Effect.Effect<LanguageModel.LanguageModel, ModelsError>;
    readonly decisionModel: (
      ref: ModelRef,
    ) => Effect.Effect<DecisionModel.DecisionModel, ModelsError>;
  }
>()("tau/ai/Models") {}

export const modelsLayer = (routes: ReadonlyArray<Route>) =>
  Layer.effect(Models, makeModels(routes));

type ClientTransform = (client: HttpClient.HttpClient) => HttpClient.HttpClient;

const makeModels = Effect.fn("makeModels")(function* (routes: ReadonlyArray<Route>) {
  const context = yield* Effect.context<CredentialStore | HttpClient.HttpClient>();

  const signedRoute = Effect.fn("signedRoute")(function* (ref: ModelRef) {
    const route = routes.find((candidate) => candidate.id === ref.route);

    if (route === undefined) {
      return yield* new UnknownRoute({
        route: ref.route,
        message: `No route is named ${ref.route}. Check the provider part of the model name.`,
      });
    }

    yield* credentialSigner(route);
    return { route, sign: yield* signRequests(route) };
  });

  const languageModel = (ref: ModelRef) =>
    signedRoute(ref).pipe(
      Effect.flatMap(({ route, sign }) => chatModel(route, ref.model, sign)),
      Effect.provideContext(context),
    );

  const decisionModel = (ref: ModelRef) =>
    signedRoute(ref).pipe(
      Effect.flatMap(({ route, sign }) => decisionModelFor(route, ref.model, sign)),
      Effect.provideContext(context),
    );

  return Models.of({ languageModel, decisionModel });
});

const chatModel = (route: Route, model: string, sign: ClientTransform) => {
  switch (route.client) {
    case "anthropic":
      return AnthropicLanguageModel.make({ model }).pipe(
        Effect.provideServiceEffect(
          AnthropicClient.AnthropicClient,
          AnthropicClient.make({ apiUrl: route.apiUrl, transformClient: sign }),
        ),
      );

    case "openai": {
      const isCodex = route.auth.kind === "chatgptSubscription";

      const transformClient = isCodex
        ? (client: HttpClient.HttpClient) => collectCodexStream(sign(client))
        : sign;

      // Tau rebuilds every request from its own session, so nothing is stored server-side and
      // reasoning comes back encrypted for the next request to replay.
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

    case "openrouter":
      // Without strict schemas some upstream providers ignore the schema and answer in prose.
      return OpenRouterLanguageModel.make({ model, config: { strictJsonSchema: true } }).pipe(
        Effect.provideServiceEffect(
          OpenRouterClient.OpenRouterClient,
          OpenRouterClient.make({ apiUrl: route.apiUrl, transformClient: sign }),
        ),
      );
  }
};

const decisionModelFor = Effect.fn("decisionModelFor")(function* (
  route: Route,
  model: string,
  sign: ClientTransform,
) {
  switch (route.decisions) {
    case undefined:
      return yield* new NoDecisionApi({
        route: route.id,
        message: `${route.id} has no decision API. Choose a decision model on openai or openrouter.`,
      });

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
