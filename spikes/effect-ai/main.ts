// Spike: can Effect's AI packages carry Tau's subscription routes, and replay recorded streams?
// `bun main.ts live` calls real providers and records; `bun main.ts replay` runs offline.
import { AnthropicClient, AnthropicLanguageModel } from "@effect/ai-anthropic";
import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai";
import {
  OpenAiClient as CompatClient,
  OpenAiLanguageModel as CompatLanguageModel,
} from "@effect/ai-openai-compat";
import { Effect, Layer, Redacted, Ref, Stream } from "effect";
import { LanguageModel, Prompt, Tool, Toolkit } from "effect/ai";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { load, loadJson, recordingProxy, replayServer, save, saveJson } from "./server.ts";

// ---------- Routes ----------

const CLAUDE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";
const OAUTH_BETAS = ["claude-code-20250219", "oauth-2025-04-20"];
const SYSTEM =
  "You are a coding agent. To compute anything, call the run tool with a JavaScript script; never compute in your head.";

type TokenSource = Effect.Effect<string>;

const LONG_SYSTEM = `${SYSTEM}\n\n${Array.from(
  { length: 400 },
  (_, index) => `Rule ${index}: keep scripts short, print only the answer, and never read files outside the workspace.`,
).join("\n")}`;

/** Adds headers on every request, reading the token each time so a refresh needs no new client. */
const withHeaders =
  (headers: (token: string, request: HttpClientRequest.HttpClientRequest) => Record<string, string>, token: TokenSource) =>
  (client: HttpClient.HttpClient) =>
    HttpClient.mapRequestEffect(client, (request) =>
      Effect.map(token, (value) => HttpClientRequest.setHeaders(request, headers(value, request))),
    );

const claudeSubscription = (apiUrl: string, token: TokenSource, model: string) =>
  AnthropicLanguageModel.layer({
    model,
    config: { max_tokens: 4096, thinking: { type: "adaptive", display: "summarized" }, output_config: { effort: "high" } } as never,
  }).pipe(
    Layer.provide(
      AnthropicClient.layer({
        apiUrl,
        transformClient: withHeaders(
          (value, request) => ({
            authorization: `Bearer ${value}`,
            "anthropic-beta": [request.headers["anthropic-beta"], ...OAUTH_BETAS].filter(Boolean).join(","),
          }),
          token,
        ),
      }),
    ),
    Layer.provide(FetchHttpClient.layer),
  );

const codexSubscription = (apiUrl: string, token: TokenSource, accountId: string) =>
  OpenAiLanguageModel.layer({
    model: "gpt-6-luna",
    config: {
      store: false,
      instructions: SYSTEM,
      include: ["reasoning.encrypted_content"],
      prompt_cache_key: "tau-effect-ai-spike",
      service_tier: "priority",
      reasoning: { effort: "high", summary: "auto" },
    } as never,
  }).pipe(
    Layer.provide(
      OpenAiClient.layer({
        apiUrl,
        transformClient: withHeaders(
          (value) => ({
            authorization: `Bearer ${value}`,
            "chatgpt-account-id": accountId,
            originator: "tau",
            "session-id": "tau-effect-ai-spike",
            "OpenAI-Beta": "responses=experimental",
          }),
          token,
        ),
      }),
    ),
    Layer.provide(FetchHttpClient.layer),
  );

const openRouter = (apiUrl: string, key: string) =>
  CompatLanguageModel.layer({
    model: "anthropic/claude-haiku-5.5",
    config: { reasoning: { effort: "high" }, max_output_tokens: 4096 } as never,
  }).pipe(
    Layer.provide(CompatClient.layer({ apiUrl, apiKey: Redacted.make(key) })),
    Layer.provide(FetchHttpClient.layer),
  );

// ---------- Prompt, tool, summary ----------

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

const firstTurn = (identity: boolean) =>
  Prompt.make([
    ...(identity ? [{ role: "system" as const, content: CLAUDE_IDENTITY }] : []),
    { role: "system" as const, content: SYSTEM },
    { role: "user" as const, content:
        "First reason carefully about whether JavaScript numbers can represent (2^61 - 17) * 3 exactly and which script avoids precision loss. Then compute it with the run tool.",
    },
  ]);

const stream = (layer: Layer.Layer<LanguageModel.LanguageModel>, prompt: Prompt.Prompt) =>
  LanguageModel.streamText({ prompt, toolkit: toolkit as never, disableToolCallResolution: true }).pipe(
    Stream.runCollect,
    Effect.provide(layer),
  ) as Effect.Effect<readonly any[], unknown>;

/** What a turn decoded to, without IDs or timestamps that differ between runs. */
const summarize = (parts: readonly any[]) => {
  let text = "";
  let reasoning = "";
  const types: string[] = [];
  const reasoningMetadata: string[] = [];
  const toolCalls: unknown[] = [];
  let finish: unknown;

  for (const part of parts) {
    if (types.at(-1) !== part.type) types.push(part.type);
    if (part.type === "text-delta") text += part.delta;
    if (part.type === "reasoning-delta") reasoning += part.delta;
    if (part.type === "reasoning-end" || part.type === "reasoning-start") {
      reasoningMetadata.push(JSON.stringify(part.metadata).slice(0, 80));
    }
    if (part.type === "tool-call") toolCalls.push({ name: part.name, params: part.params });
    if (part.type === "finish") finish = { reason: part.reason, usage: part.usage };
  }

  return { types, text, reasoning: reasoning.slice(0, 200), reasoningMetadata, toolCalls, finish };
};

const toolResult = (parts: readonly any[]) => {
  const call = parts.find((part) => part.type === "tool-call");
  if (call === undefined) throw new Error("no tool call to answer");
  return Prompt.make([
    {
      role: "tool",
      content: [{ type: "tool-result", id: call.id, name: call.name, isFailure: false, result: "6917529027641081805" }],
    },
  ]);
};

const history = (prompt: Prompt.Prompt, parts: readonly any[]) =>
  Prompt.concat(Prompt.concat(prompt, Prompt.fromResponseParts(parts)), toolResult(parts));

const outcome = (effect: Effect.Effect<readonly any[], unknown>) =>
  effect.pipe(
    Effect.map((parts) => ({ ok: true, ...summarize(parts) })),
    Effect.catchCause((cause) => Effect.succeed({ ok: false, error: String(cause).slice(0, 600) })),
  );

// ---------- Live ----------

interface Auth {
  readonly anthropic: { readonly access: string; readonly refresh: string };
  readonly "openai-codex": { readonly access: string; readonly refresh: string; readonly accountId: string };
  readonly openrouter: { readonly key: string };
}

const live = Effect.gen(function* () {
  const auth: Auth = JSON.parse(readFileSync(join(homedir(), ".pi/agent/auth.json"), "utf8"));
  const secrets = [
    auth.anthropic.access,
    auth.anthropic.refresh,
    auth["openai-codex"].access,
    auth["openai-codex"].refresh,
    auth["openai-codex"].accountId,
    auth.openrouter.key,
  ];

  const anthropicProxy = recordingProxy("https://api.anthropic.com");
  const codexProxy = recordingProxy("https://chatgpt.com/backend-api");
  const openRouterProxy = recordingProxy("https://openrouter.ai/api/v1");
  const claudeToken = Effect.succeed(auth.anthropic.access);
  const codexToken = Effect.succeed(auth["openai-codex"].access);
  const accountId = auth["openai-codex"].accountId;

  const sonnet = claudeSubscription(anthropicProxy.url, claudeToken, "claude-sonnet-5-5");
  const opus = claudeSubscription(anthropicProxy.url, claudeToken, "claude-opus-5-5");
  const codex = codexSubscription(`${codexProxy.url}/codex`, codexToken, accountId);
  const router = openRouter(openRouterProxy.url, auth.openrouter.key);

  const results: Record<string, unknown> = {};

  // Cases 1, 2, 4: first turns, recorded.
  const turns = [
    ["anthropic-oauth", sonnet, anthropicProxy, true],
    ["codex", codex, codexProxy, false],
    ["openrouter", router, openRouterProxy, false],
  ] as const;

  const parts: Record<string, readonly any[]> = {};

  for (const [name, layer, proxy, identity] of turns) {
    const before = proxy.exchanges.length;
    const result = yield* outcome(
      stream(layer, firstTurn(identity)).pipe(Effect.tap((collected) => Effect.sync(() => (parts[name] = collected)))),
    );
    results[name] = result;
    const exchange = proxy.exchanges[before];
    if (result.ok && exchange !== undefined) {
      save(name, exchange, secrets);
      saveJson(`${name}.summary`, result);
    } else if (exchange !== undefined) {
      results[`${name}:response`] = exchange.body.slice(0, 600);
    }
  }

  // Case 3: replay the Claude turn (thinking signature) and the Codex turn (encrypted reasoning) elsewhere.
  const claudeFirst = firstTurn(true);
  const plainFirst = firstTurn(false);

  if (parts["anthropic-oauth"] !== undefined) {
    const claudeHistory = history(claudeFirst, parts["anthropic-oauth"]);
    const plainClaudeHistory = history(plainFirst, parts["anthropic-oauth"]);
    results["replay claude -> same model"] = yield* outcome(stream(sonnet, claudeHistory));
    results["replay claude -> other claude model"] = yield* outcome(stream(opus, claudeHistory));
    results["replay claude -> codex"] = yield* outcome(stream(codex, plainClaudeHistory));
    results["replay claude -> openrouter"] = yield* outcome(stream(router, plainClaudeHistory));
    const sent = anthropicProxy.exchanges.slice(1).map((exchange) => JSON.stringify(exchange.request));
    results["claude replay requests carry signature"] = sent.map((body) => body.includes('"signature"'));
    const codexSent = JSON.stringify(codexProxy.exchanges.at(-1)?.request ?? null);
    results["codex request after claude carries signature or thinking"] = {
      signature: codexSent.includes("signature"),
      reasoningItem: codexSent.includes('"type":"reasoning"'),
    };
  }

  if (parts.codex !== undefined) {
    results["replay codex -> same model"] = yield* outcome(stream(codex, history(plainFirst, parts.codex)));
    results["replay codex -> claude"] = yield* outcome(stream(sonnet, history(claudeFirst, parts.codex)));
    const codexInput = ((codexProxy.exchanges.at(-1)?.request as any)?.input ?? []) as any[];
    results["codex replay request reasoning items"] = codexInput
      .filter((item) => item.type === "reasoning")
      .map((item) => ({ encrypted: typeof item.encrypted_content === "string", id: item.id !== undefined }));
  }

  if (parts.openrouter !== undefined) {
    results["replay openrouter -> same model"] = yield* outcome(stream(router, history(plainFirst, parts.openrouter)));
    const routerSent = JSON.stringify(openRouterProxy.exchanges.at(-1)?.request ?? null);
    results["openrouter replay request carries reasoning"] = {
      reasoning: routerSent.includes('"reasoning"'),
      reasoningDetails: routerSent.includes("reasoning_details"),
    };
  }

  // Prompt caching: the same long prompt twice; the second call should read from the cache.
  const cached = (identity: boolean, options: Record<string, unknown>) =>
    Prompt.make([
      ...(identity ? [{ role: "system" as const, content: CLAUDE_IDENTITY }] : []),
      { role: "system" as const, content: LONG_SYSTEM, options },
      { role: "user" as const, content: "Reply with the single word: ready." },
    ]);

  const claudeCached = cached(true, { anthropic: { cacheControl: { type: "ephemeral" } } });
  yield* outcome(stream(sonnet, claudeCached));
  results["claude cache second call"] = (yield* outcome(stream(sonnet, claudeCached))) as unknown;
  const codexCached = cached(false, {});
  yield* outcome(stream(codex, codexCached));
  results["codex cache second call"] = (yield* outcome(stream(codex, codexCached))) as unknown;

  const log = [anthropicProxy, codexProxy, openRouterProxy].flatMap((proxy) =>
    proxy.exchanges.map((exchange) => ({ ...exchange, body: exchange.body.slice(-3000) })),
  );
  const logJson = JSON.stringify(log, null, 2);
  if (secrets.some((secret) => logJson.includes(secret))) throw new Error("exchange log contains a secret");
  yield* Effect.promise(() => Bun.write("/tmp/effect-ai-exchanges.json", logJson));

  saveJson("live-results", results);
  anthropicProxy.stop();
  codexProxy.stop();
  openRouterProxy.stop();
  return results;
});

// ---------- Replay (cases 5, 6) ----------

const replay = Effect.gen(function* () {
  const results: Record<string, unknown> = {};

  for (const name of ["anthropic-oauth", "codex", "openrouter"]) {
    const recording = load(name);
    const server = replayServer(recording);
    const token = yield* Ref.make("token-1");
    const tokenSource = Ref.get(token);

    const layer =
      name === "anthropic-oauth"
        ? claudeSubscription(server.url, tokenSource, "claude-sonnet-5-5")
        : name === "codex"
          ? codexSubscription(`${server.url}/codex`, tokenSource, "account")
          : openRouter(server.url, "key");

    // One built layer serves both requests, so the second proves the token is read per request.
    const context = yield* Layer.build(layer);
    const run = stream(Layer.succeedContext(context), firstTurn(name === "anthropic-oauth"));
    const first = summarize(yield* run);
    yield* Ref.set(token, "token-2");
    yield* run;

    const live = loadJson(`${name}.summary`) as { ok: boolean };
    const { ok: _, ...expected } = live;
    results[name] = {
      sameAsLive: JSON.stringify(first) === JSON.stringify(expected),
      authorizations: server.authorizations,
      ...(JSON.stringify(first) === JSON.stringify(expected) ? {} : { replayed: first, expected }),
    };
    server.stop();
  }

  return results;
}).pipe(Effect.scoped);

const mode = Bun.argv[2];
const program = mode === "live" ? live : mode === "replay" ? replay : Effect.die("usage: main.ts live|replay");
console.log(JSON.stringify(await Effect.runPromise(program as Effect.Effect<unknown, unknown>), null, 2));
