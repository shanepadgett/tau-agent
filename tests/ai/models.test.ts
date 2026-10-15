import { describe, expect, test } from "bun:test";
import { BunCrypto, BunFileSystem } from "@effect/platform-bun";
import {
  ConfigProvider,
  Context,
  DateTime,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Redacted,
  Schema,
  Stream,
  type Scope,
} from "effect";
import { AiError, Decision, DecisionModel, LanguageModel, Prompt, Tool, Toolkit } from "effect/ai";
import { Base64Url } from "effect/encoding";
import { FetchHttpClient } from "effect/http";
import {
  ApiKey,
  ChatgptAppTokens,
  type Credential,
  CredentialStore,
  OAuthTokens,
} from "../../src/ai/Credential.ts";
import { Catalog } from "../../src/ai/Catalog.ts";
import snapshot from "../../src/ai/catalog-snapshot.json" with { type: "json" };
import { Models } from "../../src/ai/Models.ts";
import { planLimitOf } from "../../src/ai/PlanLimit.ts";
import { ConversationId } from "../../src/ai/ConversationId.ts";
import { ProviderId, ProviderTable } from "../../src/ai/Providers.ts";
import packageJson from "../../package.json" with { type: "json" };
import { TauHome } from "../../src/database/TauHome.ts";
import { catalogCacheLayer } from "../../src/host/CatalogCache.ts";
import { credentialStoreLayer } from "../../src/host/CredentialStore.ts";
import { Settings } from "../../src/host/Settings.ts";

const HOUR_MILLIS = 3_600_000;

const conversation = ConversationId.make("conversation-1");

const Recording = Schema.Struct({
  status: Schema.Number,
  contentType: Schema.String,
  body: Schema.String,
  headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  expected: Schema.optional(Schema.Json),
});

type Received = { readonly path: string; readonly headers: Headers; readonly body: string };

/**
 * Answers the requests with recorded provider responses, in order, and keeps what each request
 * carried. After the last recording, it answers with the last one again.
 */
const replayServer = (...names: [string, ...string[]]) =>
  Effect.gen(function* () {
    const recordings = yield* Effect.forEach(names, (name) =>
      Effect.promise(() => Bun.file(`${import.meta.dir}/../recordings/${name}.json`).text()).pipe(
        Effect.map(Schema.decodeUnknownSync(Schema.fromJsonString(Recording))),
      ),
    );

    const received: Received[] = [];

    const server = yield* Effect.acquireRelease(
      Effect.sync(() =>
        Bun.serve({
          port: 0,
          fetch: async (request) => {
            const recording = recordings[Math.min(received.length, recordings.length - 1)];
            if (recording === undefined) return new Response(null, { status: 500 });

            received.push({
              path: new URL(request.url).pathname,
              headers: request.headers,
              body: await request.text(),
            });

            return new Response(recording.body, {
              status: recording.status,
              headers: { ...recording.headers, "content-type": recording.contentType },
            });
          },
        }),
      ),
      (running) => Effect.promise(() => running.stop(true)),
    );

    return {
      url: `http://localhost:${server.port}`,
      received,
      expected: recordings.at(-1)?.expected,
    };
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
  ["codex", login(codexAccessToken)],
  [
    "chatgpt",
    ChatgptAppTokens.make({
      clientId: "oaiapp_test",
      idToken: Redacted.make("id-token"),
      access: Redacted.make("chatgpt-token"),
      refresh: Redacted.make("refresh"),
      expiresAt: DateTime.makeUnsafe(Date.now() + HOUR_MILLIS),
    }),
  ],
];

/** These keys come from the environment, so every run also covers the fallback. */
const environment = { OPENROUTER_API_KEY: "openrouter-key", OPENCODE_API_KEY: "opencode-key" };

const runWithModels = <A, E>(
  serverUrl: string,
  credentials: ReadonlyArray<readonly [string, Credential]>,
  program: (models: Models["Service"]) => Effect.Effect<A, E, Scope.Scope>,
  settingsText = "",
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const tauDirectory = `${yield* fileSystem.makeTempDirectoryScoped()}/.tau`;

    const home = TauHome.at(tauDirectory);
    const storeLayer = credentialStoreLayer.pipe(Layer.provide(home));
    const store = Context.get(yield* Layer.build(storeLayer), CredentialStore);

    for (const [provider, credential] of credentials) {
      yield* store.save(ProviderId.make(provider), credential);
    }

    if (settingsText !== "")
      yield* fileSystem.writeFileString(`${tauDirectory}/settings.json`, settingsText);

    const fromFile = Context.get(
      yield* Layer.build(Settings.layer.pipe(Layer.provide(home))),
      ProviderTable,
    );

    // Each built-in provider keeps its path but talks to the replay server.
    const providers = fromFile.providers.map((provider) => ({
      ...provider,
      apiUrl: provider.apiUrl.replace(/^https:\/\/[^/]+/, serverUrl),
    }));

    const catalog = Catalog.layer.pipe(
      Layer.provide(Layer.succeed(ProviderTable, { providers, settings: fromFile.settings })),
      Layer.provide(catalogCacheLayer.pipe(Layer.provide(home))),
      Layer.provide(BunCrypto.layer),
    );

    const layer = Models.layer.pipe(
      Layer.provide(catalog),
      Layer.provide(storeLayer),
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

const chatProviders = [
  {
    provider: "anthropic",
    model: "claude-sonnet-5-5",
    path: "/v1/messages",
    headers: {
      authorization: "Bearer claude-token",
      // Appended after any beta the package itself sends.
      "anthropic-beta": "claude-code-20250219,oauth-2025-04-20",
      "user-agent": `claude-cli/${snapshot.claudeCodeVersion}`,
      "x-app": "cli",
    },
  },
  {
    provider: "openai",
    model: "gpt-6-luna",
    path: "/v1/responses",
    headers: { authorization: "Bearer openai-key", "user-agent": `tau/${packageJson.version}` },
  },
  {
    provider: "codex",
    model: "gpt-6-luna",
    path: "/backend-api/codex/responses",
    headers: { authorization: `Bearer ${codexAccessToken}`, "chatgpt-account-id": "account-123" },
  },
  {
    provider: "openrouter",
    model: "anthropic/claude-haiku-5.5",
    path: "/api/v1/chat/completions",
    headers: { authorization: "Bearer openrouter-key" },
  },
];

const expectSigned = (received: Received | undefined, expected: (typeof chatProviders)[number]) => {
  expect(received?.path).toBe(expected.path);

  for (const [name, value] of Object.entries(expected.headers))
    expect(received?.headers.get(name)).toEndWith(value);
};

type ChatModel = { readonly provider: string; readonly model: string };

const review = (models: Models["Service"], chat: ChatModel, prompt: Prompt.RawInput) =>
  Effect.gen(function* () {
    const model = yield* models.languageModel(
      {
        provider: ProviderId.make(chat.provider),
        model: chat.model,
      },
      conversation,
    );

    const response = yield* LanguageModel.generateObject({
      prompt,
      schema: Review,
      objectName: "review",
    }).pipe(Effect.provideService(LanguageModel.LanguageModel, model));

    return response.value;
  });

const generateReview = (serverUrl: string, chat: ChatModel, prompt: Prompt.RawInput) =>
  runWithModels(serverUrl, storedCredentials, (models) => review(models, chat, prompt));

/**
 * The first OpenCode Go model in the bundled snapshot with native structured output that uses
 * `npm`'s protocol, or the provider's own.
 */
const openCodeGoModel = (npm: string | undefined) => {
  const models = Object.entries(snapshot.modelsDev["opencode-go"].models);

  const found = models.find(
    ([, model]) =>
      ("provider" in model ? model.provider.npm : undefined) === npm &&
      "structured_output" in model &&
      model.structured_output,
  );

  if (found === undefined) throw new Error(`The snapshot has no OpenCode Go model for ${npm}`);
  return found[0];
};

const codex: ChatModel = { provider: "codex", model: "gpt-6-luna" };

describe("models", () => {
  test.each(chatProviders)("$provider streams a recorded turn that calls a tool", (expected) =>
    run(
      Effect.gen(function* () {
        const server = yield* replayServer(`${expected.provider}-stream`);

        const parts = yield* runWithModels(server.url, storedCredentials, (models) =>
          Effect.gen(function* () {
            const model = yield* models.languageModel(
              {
                provider: ProviderId.make(expected.provider),
                model: expected.model,
              },
              conversation,
            );

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

  test.each(chatProviders)("$provider returns a recorded structured object", (expected) =>
    run(
      Effect.gen(function* () {
        const server = yield* replayServer(`${expected.provider}-object`);

        const review = yield* generateReview(
          server.url,
          expected,
          "Review the rename of `update` to `refresh`.",
        );

        expect(review).toEqual(Schema.decodeUnknownSync(Review)(server.expected));
        expectSigned(server.received[0], expected);
      }),
    ),
  );

  // Codex sometimes ends a stream with an empty `output` in `response.completed`; the reply is in
  // the item events, as in the recording that blanks it.
  test.each(["codex-object", "codex-object-empty-output"])(
    "Codex structured output is sent as a stream and read from its items (%s)",
    (recording) =>
      run(
        Effect.gen(function* () {
          const server = yield* replayServer(recording);
          const review = yield* generateReview(server.url, codex, "Review it.");

          const StreamingBody = Schema.fromJsonString(
            Schema.Struct({ stream: Schema.Literal(true) }),
          );

          expect(review).toEqual(Schema.decodeUnknownSync(Review)(server.expected));

          expect(() =>
            Schema.decodeUnknownSync(StreamingBody)(server.received[0]?.body),
          ).not.toThrow();
        }),
      ),
  );

  // Sign in with ChatGPT refuses requests that do not stream; the Codex recording has the same events.
  test("Sign in with ChatGPT requests are streamed and carry the app token", () =>
    run(
      Effect.gen(function* () {
        const server = yield* replayServer("codex-object");
        const chatgpt = { provider: "chatgpt", model: "gpt-6.1-sol" };
        const review = yield* generateReview(server.url, chatgpt, "Review it.");

        const StreamingBody = Schema.fromJsonString(
          Schema.Struct({ stream: Schema.Literal(true), store: Schema.Literal(false) }),
        );

        expect(review).toEqual(Schema.decodeUnknownSync(Review)(server.expected));
        expect(server.received[0]?.path).toBe("/v1/responses");
        expect(server.received[0]?.headers.get("authorization")).toBe("Bearer chatgpt-token");

        expect(() =>
          Schema.decodeUnknownSync(StreamingBody)(server.received[0]?.body),
        ).not.toThrow();
      }),
    ));

  test.each([
    { chat: { provider: "openai", model: "gpt-6-luna" }, recording: "openai-object" },
    { chat: codex, recording: "codex-object" },
    { chat: { provider: "chatgpt", model: "gpt-6.1-sol" }, recording: "codex-object" },
  ])(
    "$chat.provider requests carry the conversation ID as the prompt cache key and session ID",
    (expected) =>
      run(
        Effect.gen(function* () {
          const server = yield* replayServer(expected.recording);
          yield* generateReview(server.url, expected.chat, "Review it.");

          const CacheKeyBody = Schema.fromJsonString(
            Schema.Struct({ prompt_cache_key: Schema.Literal(conversation) }),
          );

          expect(() =>
            Schema.decodeUnknownSync(CacheKeyBody)(server.received[0]?.body),
          ).not.toThrow();

          expect(server.received[0]?.headers.get("session-id")).toBe(conversation);
        }),
      ),
  );

  test.each([
    { name: "ChatGPT usage limit", chat: codex, recording: "codex-usage-limit", plan: "ChatGPT" },
    {
      name: "Claude usage limit",
      chat: { provider: "anthropic", model: "claude-sonnet-5-5" },
      recording: "anthropic-usage-limit",
      plan: "Claude",
    },
    { name: "ChatGPT rate limit", chat: codex, recording: "codex-rate-limit", plan: undefined },
  ])("a 429 reply: $name", (expected) =>
    run(
      Effect.gen(function* () {
        const server = yield* replayServer(expected.recording);
        const error = yield* Effect.flip(generateReview(server.url, expected.chat, "Review it."));
        const limit = AiError.isAiError(error) ? planLimitOf(error) : Option.none();

        expect(server.received).toHaveLength(1);
        expect(Option.getOrUndefined(limit)?.plan.name).toBe(expected.plan);

        if (Option.isSome(limit)) {
          expect(Option.map(limit.value.resetAt, DateTime.toEpochMillis)).toEqual(
            Option.some(1_791_900_000_000),
          );
        }
      }),
    ),
  );

  test("Claude subscription requests start the system prompt with the Claude Code identity", () =>
    run(
      Effect.gen(function* () {
        const server = yield* replayServer("anthropic-object");

        yield* generateReview(server.url, { provider: "anthropic", model: "claude-sonnet-5-5" }, [
          { role: "system", content: "You review renames." },
          { role: "user", content: "Review it." },
        ]);

        const SystemBody = Schema.fromJsonString(
          Schema.Struct({ system: Schema.Array(Schema.Struct({ text: Schema.String })) }),
        );

        const { system } = Schema.decodeUnknownSync(SystemBody)(server.received[0]?.body);

        expect(system.map((block) => block.text)).toEqual([
          "You are Claude Code, Anthropic's official CLI for Claude.",
          "You review renames.",
        ]);
      }),
    ));

  test.each([
    {
      provider: "openrouter",
      model: "~typesafe/jev-latest",
      path: "/api/v1/systemone",
      authorization: "Bearer openrouter-key",
    },
    {
      provider: "openai",
      model: "gpt-6-luna",
      path: "/v1/decisions",
      authorization: "Bearer openai-key",
    },
  ])("$provider answers recorded decisions", (expected) =>
    run(
      Effect.gen(function* () {
        const server = yield* replayServer(`${expected.provider}-decision`);

        const decided = yield* runWithModels(server.url, storedCredentials, (models) =>
          Effect.gen(function* () {
            const model = yield* models.decisionModel({
              provider: ProviderId.make(expected.provider),
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

  test.each([
    {
      protocol: "Messages",
      model: openCodeGoModel("@ai-sdk/anthropic"),
      recording: "anthropic-object",
      path: "/inference/go/v1/messages",
      header: ["x-api-key", "opencode-key"],
    },
    {
      protocol: "Chat Completions",
      model: openCodeGoModel(undefined),
      recording: "openrouter-object",
      path: "/inference/go/v1/chat/completions",
      header: ["authorization", "Bearer opencode-key"],
    },
  ])("OpenCode Go sends a $protocol model to its path at the same address", (expected) =>
    run(
      Effect.gen(function* () {
        const server = yield* replayServer(expected.recording);
        const goModel = { provider: "opencode-go", model: expected.model };
        const reviewed = yield* generateReview(server.url, goModel, "Review it.");
        const [name = "", value] = expected.header;

        expect(reviewed).toEqual(Schema.decodeUnknownSync(Review)(server.expected));
        expect(server.received[0]?.path).toBe(expected.path);
        expect(server.received[0]?.headers.get(name)).toBe(value);
        expect(server.received[0]?.headers.get("x-opencode-session")).toBe(conversation);
        expect(server.received[0]?.headers.get("x-opencode-client")).toBe("tau");
      }),
    ),
  );

  // Recorded from OpenCode Go, whose Messages replies leave out `stop_sequence` and cache usage.
  test.each(["object", "stream"])(
    "a Messages reply without the fields Anthropic always sends still gives its text (%s)",
    (kind) =>
      run(
        Effect.gen(function* () {
          const server = yield* replayServer(`opencode-go-messages-${kind}`);

          const ref = {
            provider: ProviderId.make("opencode-go"),
            model: openCodeGoModel("@ai-sdk/anthropic"),
          };

          const text = yield* runWithModels(server.url, storedCredentials, (models) =>
            Effect.gen(function* () {
              const model = yield* models.languageModel(ref, conversation);
              const prompt = "Reply with exactly: ok";

              const reply =
                kind === "stream"
                  ? LanguageModel.streamText({ prompt }).pipe(
                      Stream.runCollect,
                      Effect.map((parts) =>
                        parts
                          .flatMap((part) => (part.type === "text-delta" ? [part.delta] : []))
                          .join(""),
                      ),
                    )
                  : LanguageModel.generateText({ prompt }).pipe(
                      Effect.map((response) => response.text),
                    );

              return yield* reply.pipe(Effect.provideService(LanguageModel.LanguageModel, model));
            }),
          );

          expect(text.trim()).toBe("ok");
        }),
      ),
  );

  test("a provider from the settings file reaches its own address and sends no key", () =>
    run(
      Effect.gen(function* () {
        const server = yield* replayServer("openrouter-object");

        const settingsText = `{
          // A local server that needs no key
          "providers": {
            "local": {
              "protocol": "openaiChat",
              "apiUrl": "${server.url}/v1",
              "models": {
                "qwen": {
                  "contextTokens": 32768,
                  "outputTokens": 8192,
                  "supports": { "structuredOutput": true },
                },
              },
            },
          },
        }`;

        const local = { provider: "local", model: "qwen" };

        const reviewed = yield* runWithModels(
          server.url,
          [],
          (models) => review(models, local, "Review it."),
          settingsText,
        );

        expect(reviewed).toEqual(Schema.decodeUnknownSync(Review)(server.expected));
        expect(server.received[0]?.path).toBe("/v1/chat/completions");
        expect(server.received[0]?.headers.get("authorization")).toBeNull();
      }),
    ));

  test.each([
    { kind: "chat", provider: "openai", model: "gpt-0-unknown" },
    { kind: "decision", provider: "openrouter", model: "unknown/decider" },
  ])("an unknown $kind model fails with a hint to add it in settings", (unknown) =>
    run(
      Effect.gen(function* () {
        const server = yield* replayServer("openai-stream");
        const ref = { provider: ProviderId.make(unknown.provider), model: unknown.model };

        const exit = yield* runWithModels(server.url, storedCredentials, (models) =>
          Effect.exit(
            unknown.kind === "chat"
              ? Effect.asVoid(models.languageModel(ref, conversation))
              : Effect.asVoid(models.decisionModel(ref)),
          ),
        );

        expect(Exit.isFailure(exit) && String(exit.cause)).toContain("~/.tau/settings.json");
        expect(server.received).toHaveLength(0);
      }),
    ),
  );

  test("a provider without a credential fails before sending anything", () =>
    run(
      Effect.gen(function* () {
        const server = yield* replayServer("openai-stream");

        const exit = yield* runWithModels(server.url, [], (models) =>
          Effect.exit(
            models.languageModel(
              { provider: ProviderId.make("openai"), model: "gpt-6-luna" },
              conversation,
            ),
          ),
        );

        expect(Exit.isFailure(exit) && String(exit.cause)).toContain(
          "openai has no stored credential",
        );

        expect(server.received).toHaveLength(0);
      }),
    ));
});

const openai: ChatModel = { provider: "openai", model: "gpt-6-luna" };

describe("structured output", () => {
  // Recorded from OpenCode Go. Neither model has native structured output.
  test.each([
    { protocol: "chat", model: "kimi-k2.6" },
    { protocol: "messages", model: "minimax-m2.7" },
  ])("$model returns the object through a forced tool call", (expected) =>
    run(
      Effect.gen(function* () {
        const server = yield* replayServer(`opencode-go-forced-tool-${expected.protocol}`);
        const goModel = { provider: "opencode-go", model: expected.model };
        const reviewed = yield* generateReview(server.url, goModel, "Review it.");
        const request = server.received[0]?.body ?? "";

        expect(reviewed).toEqual(Schema.decodeUnknownSync(Review)(server.expected));
        expect(server.received).toHaveLength(1);
        expect(request).toContain('"name":"review"');
        expect(request).not.toContain("response_format");
        expect(request).not.toContain("output_format");

        expect(server.received[0]?.headers.get("anthropic-beta") ?? "").not.toContain(
          "structured-outputs",
        );
      }),
    ),
  );

  // `openai-object-invalid` is `openai-object` with `risk` changed to a value the schema refuses.
  test("an invalid object gets one retry that tells the model why", () =>
    run(
      Effect.gen(function* () {
        const server = yield* replayServer("openai-object-invalid", "openai-object");
        const reviewed = yield* generateReview(server.url, openai, "Review it.");

        expect(reviewed).toEqual(Schema.decodeUnknownSync(Review)(server.expected));
        expect(server.received).toHaveLength(2);
        expect(server.received[1]?.body).toContain('\\"risk\\":\\"severe\\"');
        expect(server.received[1]?.body).toContain("That answer does not match the schema");
      }),
    ));

  test("a second invalid object fails with a structured output error", () =>
    run(
      Effect.gen(function* () {
        const server = yield* replayServer("openai-object-invalid");
        const exit = yield* Effect.exit(generateReview(server.url, openai, "Review it."));

        expect(Exit.isFailure(exit) && String(exit.cause)).toContain("StructuredOutputError");
        expect(server.received).toHaveLength(2);
      }),
    ));

  test("a model that cannot call tools is hidden, unless settings say it can", () =>
    run(
      Effect.gen(function* () {
        const server = yield* replayServer("openai-object");
        const ref = { provider: ProviderId.make("openai"), model: "gpt-3.5-turbo" };

        const languageModel = (models: Models["Service"]) =>
          Effect.exit(models.languageModel(ref, conversation));

        const hidden = yield* runWithModels(server.url, storedCredentials, languageModel);

        const shown = yield* runWithModels(
          server.url,
          storedCredentials,
          languageModel,
          `{ "providers": { "openai": { "models": { "gpt-3.5-turbo": { "supports": { "tools": true } } } } } }`,
        );

        expect(Exit.isFailure(hidden) && String(hidden.cause)).toContain("cannot call tools");
        expect(Exit.isSuccess(shown)).toBe(true);
        expect(server.received).toHaveLength(0);
      }),
    ));
});
