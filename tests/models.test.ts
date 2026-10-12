import { describe, expect, test } from "bun:test";
import { BunFileSystem } from "@effect/platform-bun";
import {
  ConfigProvider,
  Context,
  DateTime,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Redacted,
  Schema,
  Stream,
  type Scope,
} from "effect";
import { Decision, DecisionModel, LanguageModel, Prompt, Tool, Toolkit } from "effect/ai";
import { Base64Url } from "effect/encoding";
import { FetchHttpClient } from "effect/http";
import {
  ApiKey,
  type Credential,
  CredentialStore,
  OAuthTokens,
  ProviderId,
} from "../src/ai/credential.ts";
import { Models, modelsLayer } from "../src/ai/models.ts";
import { builtInRoutes, RouteId } from "../src/ai/routes.ts";
import { credentialStoreLayer } from "../src/host/credential-store.ts";

const HOUR_MILLIS = 3_600_000;

const Recording = Schema.Struct({
  status: Schema.Number,
  contentType: Schema.String,
  body: Schema.String,
  expected: Schema.optional(Schema.Json),
});

type Received = { readonly path: string; readonly headers: Headers; readonly body: string };

/** Answers every request with one recorded provider response and keeps what each request carried. */
const replayServer = (name: string) =>
  Effect.gen(function* () {
    const recording = Schema.decodeUnknownSync(Schema.fromJsonString(Recording))(
      yield* Effect.promise(() => Bun.file(`${import.meta.dir}/recordings/${name}.json`).text()),
    );

    const received: Received[] = [];

    const server = yield* Effect.acquireRelease(
      Effect.sync(() =>
        Bun.serve({
          port: 0,
          fetch: async (request) => {
            received.push({
              path: new URL(request.url).pathname,
              headers: request.headers,
              body: await request.text(),
            });

            return new Response(recording.body, {
              status: recording.status,
              headers: { "content-type": recording.contentType },
            });
          },
        }),
      ),
      (running) => Effect.promise(() => running.stop(true)),
    );

    return { url: `http://localhost:${server.port}`, received, expected: recording.expected };
  });

/** A JWT whose payload carries the ChatGPT account claim Codex needs. */
const chatgptToken = Base64Url.encode(
  JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "account-123" } }),
);

const codexAccessToken = `header.${chatgptToken}.signature`;

const login = (access: string) =>
  OAuthTokens.make({
    access: Redacted.make(access),
    refresh: Redacted.make("refresh"),
    expiresAt: DateTime.makeUnsafe(Date.now() + HOUR_MILLIS),
  });

const storedCredentials: ReadonlyArray<readonly [string, Credential]> = [
  ["anthropic", login("claude-token")],
  ["openai", ApiKey.make({ key: Redacted.make("openai-key") })],
  ["openai-codex", login(codexAccessToken)],
];

/** OpenRouter's key comes from the environment, so every run also covers the fallback. */
const environment = { OPENROUTER_API_KEY: "openrouter-key" };

const runWithModels = <A, E>(
  serverUrl: string,
  credentials: ReadonlyArray<readonly [string, Credential]>,
  program: (models: Models["Service"]) => Effect.Effect<A, E, Scope.Scope>,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const tauDirectory = `${yield* fileSystem.makeTempDirectoryScoped()}/.tau`;

    const store = Context.get(
      yield* Layer.build(credentialStoreLayer(tauDirectory)),
      CredentialStore,
    );

    for (const [provider, credential] of credentials) {
      yield* store.save(ProviderId.make(provider), credential);
    }

    // Each route keeps its path but talks to the replay server.
    const routes = builtInRoutes.map((route) => ({
      ...route,
      apiUrl: route.apiUrl.replace(/^https:\/\/[^/]+/, serverUrl),
    }));

    const layer = modelsLayer(routes).pipe(
      Layer.provide(credentialStoreLayer(tauDirectory)),
      Layer.provide(FetchHttpClient.layer),
      Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(environment))),
    );

    const models = Context.get(yield* Layer.build(layer), Models);
    return yield* program(models);
  });

const run = <A, E>(program: Effect.Effect<A, E, Scope.Scope | FileSystem.FileSystem>) =>
  Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(BunFileSystem.layer)));

const RunTool = Tool.dynamic("run", {
  description: "Run a JavaScript script and return what it prints.",
  parameters: {
    type: "object",
    properties: { script: { type: "string" } },
    required: ["script"],
    additionalProperties: false,
  },
});

const toolkit = Toolkit.make(RunTool);

const Review = Schema.Struct({
  risk: Schema.Literals(["low", "medium", "high"]),
  files: Schema.Array(Schema.String),
  summary: Schema.String,
});

const routeDecisions = Decision.make({
  input: Schema.Struct({ prompt: Schema.String, repository: Schema.String }),
  decisions: {
    route: Decision.classify({
      instructions: "What kind of work does the prompt ask for?",
      criteria: {
        code: "Change or write code in the repository.",
        question: "Answer a question without changing files.",
        chat: "Small talk with no task.",
      },
    }),
    offTopic: Decision.probability({
      instructions: "Is the prompt unrelated to software work in this repository?",
      criteria: { false: "It is about this repository.", true: "It is unrelated." },
    }),
    effort: Decision.rate({
      instructions: "How much work will the prompt take?",
      criteria: ["trivial", "small", "large"],
    }),
  },
});

const chatRoutes = [
  {
    route: "anthropic",
    model: "claude-sonnet-5-5",
    path: "/v1/messages",
    headers: {
      authorization: "Bearer claude-token",
      // Appended after any beta the package itself sends.
      "anthropic-beta": "claude-code-20250219,oauth-2025-04-20",
    },
  },
  {
    route: "openai",
    model: "gpt-6-luna",
    path: "/v1/responses",
    headers: { authorization: "Bearer openai-key" },
  },
  {
    route: "openai-codex",
    model: "gpt-6-luna",
    path: "/backend-api/codex/responses",
    headers: { authorization: `Bearer ${codexAccessToken}`, "chatgpt-account-id": "account-123" },
  },
  {
    route: "openrouter",
    model: "anthropic/claude-haiku-5.5",
    path: "/api/v1/chat/completions",
    headers: { authorization: "Bearer openrouter-key" },
  },
];

const expectSigned = (received: Received | undefined, expected: (typeof chatRoutes)[number]) => {
  expect(received?.path).toBe(expected.path);

  for (const [name, value] of Object.entries(expected.headers))
    expect(received?.headers.get(name)).toEndWith(value);
};

describe("models", () => {
  test.each(chatRoutes)("$route streams a recorded turn that calls a tool", (expected) =>
    run(
      Effect.gen(function* () {
        const server = yield* replayServer(`${expected.route}-stream`);

        const parts = yield* runWithModels(server.url, storedCredentials, (models) =>
          Effect.gen(function* () {
            const model = yield* models.languageModel({
              route: RouteId.make(expected.route),
              model: expected.model,
            });

            const prompt = Prompt.make("Compute (2^61 - 17) * 3 with the run tool.");

            return yield* LanguageModel.streamText({
              prompt,
              toolkit,
              disableToolCallResolution: true,
            }).pipe(Stream.runCollect, Effect.provideService(LanguageModel.LanguageModel, model));
          }),
        );

        expect(parts.some((part) => part.type === "tool-call" && part.name === "run")).toBe(true);

        expect(parts.some((part) => part.type === "finish" && part.reason === "tool-calls")).toBe(
          true,
        );

        expectSigned(server.received[0], expected);
      }),
    ),
  );

  test.each(chatRoutes)("$route returns a recorded structured object", (expected) =>
    run(
      Effect.gen(function* () {
        const server = yield* replayServer(`${expected.route}-object`);

        const review = yield* runWithModels(server.url, storedCredentials, (models) =>
          Effect.gen(function* () {
            const model = yield* models.languageModel({
              route: RouteId.make(expected.route),
              model: expected.model,
            });

            const response = yield* LanguageModel.generateObject({
              prompt: "Review the rename of `update` to `refresh`.",
              schema: Review,
              objectName: "review",
            }).pipe(Effect.provideService(LanguageModel.LanguageModel, model));

            return response.value;
          }),
        );

        expect(review).toEqual(Schema.decodeUnknownSync(Review)(server.expected));
        expectSigned(server.received[0], expected);
      }),
    ),
  );

  test("Codex structured output is sent as a stream", () =>
    run(
      Effect.gen(function* () {
        const server = yield* replayServer("openai-codex-object");

        yield* runWithModels(server.url, storedCredentials, (models) =>
          Effect.gen(function* () {
            const model = yield* models.languageModel({
              route: RouteId.make("openai-codex"),
              model: "gpt-6-luna",
            });

            yield* LanguageModel.generateObject({ prompt: "Review it.", schema: Review }).pipe(
              Effect.provideService(LanguageModel.LanguageModel, model),
            );
          }),
        );

        const StreamingBody = Schema.fromJsonString(
          Schema.Struct({ stream: Schema.Literal(true) }),
        );

        expect(() =>
          Schema.decodeUnknownSync(StreamingBody)(server.received[0]?.body),
        ).not.toThrow();
      }),
    ));

  test.each([
    {
      route: "openrouter",
      model: "~typesafe/jev-latest",
      path: "/api/v1/systemone",
      authorization: "Bearer openrouter-key",
    },
    {
      route: "openai",
      model: "gpt-6-luna",
      path: "/v1/decisions",
      authorization: "Bearer openai-key",
    },
  ])("$route answers recorded decisions", (expected) =>
    run(
      Effect.gen(function* () {
        const server = yield* replayServer(`${expected.route}-decision`);

        const decided = yield* runWithModels(server.url, storedCredentials, (models) =>
          Effect.gen(function* () {
            const model = yield* models.decisionModel({
              route: RouteId.make(expected.route),
              model: expected.model,
            });

            const input = { prompt: "Rename update to refresh.", repository: "Tau" };

            return yield* DecisionModel.decide(routeDecisions, { input }).pipe(
              Effect.provideService(DecisionModel.DecisionModel, model),
            );
          }),
        );

        expect<unknown>(decided).toEqual(server.expected);
        expect(server.received[0]?.path).toBe(expected.path);
        expect(server.received[0]?.headers.get("authorization")).toBe(expected.authorization);
      }),
    ),
  );

  test("a route without a credential fails before sending anything", () =>
    run(
      Effect.gen(function* () {
        const server = yield* replayServer("openai-stream");

        const exit = yield* runWithModels(server.url, [], (models) =>
          Effect.exit(models.languageModel({ route: RouteId.make("openai"), model: "gpt-6-luna" })),
        );

        expect(Exit.isFailure(exit) && String(exit.cause)).toContain(
          "openai has no stored credential",
        );

        expect(server.received).toHaveLength(0);
      }),
    ));

  test("an expired login fails before sending anything", () =>
    run(
      Effect.gen(function* () {
        const server = yield* replayServer("anthropic-stream");

        const expired = OAuthTokens.make({
          access: Redacted.make("claude-token"),
          refresh: Redacted.make("refresh"),
          expiresAt: DateTime.makeUnsafe(Date.now()),
        });

        const exit = yield* runWithModels(server.url, [["anthropic", expired]], (models) =>
          Effect.exit(
            models.languageModel({
              route: RouteId.make("anthropic"),
              model: "claude-sonnet-5-5",
            }),
          ),
        );

        expect(Exit.isFailure(exit) && String(exit.cause)).toContain("anthropic login has expired");
        expect(server.received).toHaveLength(0);
      }),
    ));
});
