// Live check of Tau's own route code with the credentials `tau login` saved in ~/.tau.
// Prints answers, usage and expiry times; never prints a token.
import { homedir } from "node:os";
import { join } from "node:path";
import { BunCrypto, BunFileSystem } from "@effect/platform-bun";
import { DateTime, Effect, Layer, Option, Predicate, Redacted, Schema, Stream } from "effect";
import { Decision, DecisionModel, LanguageModel } from "effect/ai";
import { FetchHttpClient } from "effect/http";
import { CredentialStore, OAuthTokens, ProviderId } from "../../src/ai/credential.ts";
import { catalogLayer, publicCatalogSources } from "../../src/ai/catalog.ts";
import { Models, modelsLayer } from "../../src/ai/models.ts";
import { ConversationId } from "../../src/ai/route-auth.ts";
import { RouteId } from "../../src/ai/routes.ts";
import { catalogCacheLayer } from "../../src/host/catalog-cache.ts";
import { credentialStoreLayer } from "../../src/host/credential-store.ts";
import { readSettings } from "../../src/host/settings.ts";

const tauDirectory = join(homedir(), ".tau");

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

const subscriptions = [
  { route: "anthropic", model: "claude-sonnet-5-5" },
  { route: "codex", model: "gpt-6-luna" },
  { route: "chatgpt", model: "gpt-6.1-sol" },
];

// One model per protocol on OpenCode Go: Messages, Responses, Chat Completions.
const openCodeGoModels = ["minimax-m2.7", "gpt-6-luna", "kimi-k2.6"];

const decisionModels = [
  { route: "openrouter", model: "~typesafe/jev-latest" },
  { route: "openrouter", model: "openai/gpt-6-luna-decisions" },
  { route: "openai", model: "gpt-6-luna" },
];

const mode = process.argv[2] ?? "full";

/** Raw Codex response bodies, captured by the fetch below. */
const codexStreams: string[] = [];
// Raw OpenCode Go replies, to see which fields its endpoints send.
const openCodeGoBodies: string[] = [];

const capturingFetch: typeof fetch = Object.assign(
  async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("api.anthropic.com") && process.argv.includes("--claude-headers")) {
      const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
      headers.set("user-agent", "claude-cli/2.1.280");
      headers.set("x-app", "cli");
      init = { ...init, headers };
    }
    const response = await fetch(input, init);
    const isCodex = url.includes("/codex/responses");
    if (!isCodex && !url.includes("/inference/go/")) return response;
    const body = await response.text();
    (isCodex ? codexStreams : openCodeGoBodies).push(body);
    return new Response(body, { status: response.status, headers: response.headers });
  },
  { preconnect: fetch.preconnect },
);

const program = Effect.gen(function* () {
  const models = yield* Models;
  const store = yield* CredentialStore;

  const chat = (route: string, model: string) =>
    models.languageModel({ route: RouteId.make(route), model }, ConversationId.make(crypto.randomUUID())).pipe(
      Effect.flatMap((languageModel) =>
        LanguageModel.generateText({
          prompt:
            route === "anthropic" && process.argv.includes("--identity")
              ? [
                  { role: "system", content: "You are Claude Code, Anthropic's official CLI for Claude." },
                  { role: "user", content: "Reply with exactly: ok" },
                ]
              : "Reply with exactly: ok",
        }).pipe(
          Effect.provideService(LanguageModel.LanguageModel, languageModel),
        ),
      ),
      Effect.map((response) => ({ text: response.text.trim(), usage: response.usage })),
    );

  const streamedChat = (route: string, model: string) =>
    models.languageModel({ route: RouteId.make(route), model }, ConversationId.make(crypto.randomUUID())).pipe(
      Effect.flatMap((languageModel) =>
        LanguageModel.streamText({ prompt: "Reply with exactly: ok" }).pipe(
          Stream.runCollect,
          Effect.provideService(LanguageModel.LanguageModel, languageModel),
        ),
      ),
      Effect.map((parts) =>
        parts.flatMap((part) => (part.type === "text-delta" ? [part.delta] : [])).join("").trim(),
      ),
    );

  const storedTokens = (provider: string) =>
    store.read(ProviderId.make(provider)).pipe(
      Effect.map((stored) =>
        Option.isSome(stored) && Predicate.isTagged(stored.value, "OAuthTokens")
          ? stored.value
          : undefined,
      ),
    );

  const report: Record<string, unknown> = {};

  if (mode === "chat") {
    for (const { route, model } of subscriptions) {
      const tokens = yield* storedTokens(route);
      report[`${route} chat`] = yield* Effect.result(chat(route, model));
      report[`${route} stored expiry`] = tokens === undefined ? undefined : DateTime.formatIso(tokens.expiresAt);
    }
    return report;
  }

  if (mode === "opencode-go") {
    for (const model of openCodeGoModels) {
      openCodeGoBodies.length = 0;
      report[`opencode-go ${model}`] = yield* Effect.result(chat("opencode-go", model));
      report[`opencode-go ${model} raw`] = openCodeGoBodies.join("\n");
      openCodeGoBodies.length = 0;
      report[`opencode-go ${model} stream`] = yield* Effect.result(streamedChat("opencode-go", model));
      report[`opencode-go ${model} stream raw`] = openCodeGoBodies.join("\n");
    }
    return report;
  }

  if (mode === "codex-stream") {
    const runs = [];
    for (let attempt = 0; attempt < 5; attempt++) {
      codexStreams.length = 0;
      const result = yield* Effect.result(chat("codex", "gpt-6-luna"));
      const events = (codexStreams[0] ?? "")
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => { try { return JSON.parse(line.slice(6)); } catch { return undefined; } })
        .filter((event) => event !== undefined);
      const completed = events.find((event) => event.type === "response.completed");
      runs.push({
        text: result._tag === "Success" ? result.success.text : String(result),
        eventTypes: [...new Set(events.map((event) => event.type))],
        doneItems: events.filter((event) => event.type === "response.output_item.done").map((event) => ({ type: event.item?.type, phase: event.item?.phase, content: event.item?.content })),
        completedOutput: completed?.response?.output,
      });
    }
    report.runs = runs;
    return report;
  }

  for (const { route, model } of subscriptions) {
    report[`${route} chat`] = yield* Effect.result(chat(route, model));

    const before = yield* storedTokens(route);
    if (before === undefined) {
      report[`${route} refresh`] = "no saved subscription tokens";
      continue;
    }

    // Mark the saved tokens expired so the next request must refresh them.
    yield* store.save(ProviderId.make(route), OAuthTokens.make({ ...before, expiresAt: DateTime.makeUnsafe(Date.now()) }));
    const afterCall = yield* Effect.result(chat(route, model));
    const after = yield* storedTokens(route);

    report[`${route} refresh`] = {
      chatAfterRefresh: afterCall,
      accessChanged: after !== undefined && Redacted.value(after.access) !== Redacted.value(before.access),
      refreshChanged: after !== undefined && Redacted.value(after.refresh) !== Redacted.value(before.refresh),
      expiresBefore: DateTime.formatIso(before.expiresAt),
      expiresAfter: after === undefined ? undefined : DateTime.formatIso(after.expiresAt),
    };
  }

  for (const { route, model } of decisionModels) {
    report[`decision ${route} ${model}`] = yield* Effect.result(
      models.decisionModel({ route: RouteId.make(route), model }).pipe(
        Effect.flatMap((decisionModel) =>
          DecisionModel.decide(routeDecisions, {
            input: { prompt: "Rename update to refresh in the credential store.", repository: "Tau" },
          }).pipe(Effect.provideService(DecisionModel.DecisionModel, decisionModel)),
        ),
      ),
    );
  }

  return report;
});

const settings = await Effect.runPromise(
  readSettings(tauDirectory).pipe(Effect.provide(BunFileSystem.layer)),
);

const catalog = catalogLayer({
  routes: settings.routes,
  settings: settings.routeSettings,
  sources: publicCatalogSources,
}).pipe(Layer.provide(catalogCacheLayer(tauDirectory)), Layer.provide(BunCrypto.layer));

const layer = modelsLayer.pipe(
  Layer.provideMerge(catalog),
  Layer.provideMerge(credentialStoreLayer(tauDirectory)),
  Layer.provideMerge(FetchHttpClient.layer),
  Layer.provideMerge(Layer.succeed(FetchHttpClient.Fetch, capturingFetch)),
  Layer.provide(BunFileSystem.layer),
);

const report = await Effect.runPromise(
  Effect.gen(function* () {
    const context = yield* Layer.build(layer);
    return yield* program.pipe(Effect.provideContext(context));
  }).pipe(Effect.scoped, Effect.provide(BunFileSystem.layer)),
);

const json = JSON.stringify(report, (_key, value) => (typeof value === "bigint" ? String(value) : value), 2);
await Bun.write(`${import.meta.dir}/results-${mode}.json`, json);
console.log(json);
