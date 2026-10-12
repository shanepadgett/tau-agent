// Spike cases 8-13: decision models, the OpenAI API-key route, structured output, OpenRouter's own package.
// `bun more.ts live` calls real providers and records; `bun more.ts replay` runs offline.
import { AnthropicClient, AnthropicLanguageModel } from "@effect/ai-anthropic";
import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai";
import {
  OpenAiClient as CompatClient,
  OpenAiLanguageModel as CompatLanguageModel,
} from "@effect/ai-openai-compat";
import { OpenRouterClient, OpenRouterDecisionModel, OpenRouterLanguageModel } from "@effect/ai-openrouter";
import { Effect, Layer, Redacted, Schema, Stream } from "effect";
import { AiError, Decision, DecisionModel, LanguageModel, Prompt, Tool, Toolkit } from "effect/ai";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { load, loadJson, recordingProxy, replayServer, save, saveJson } from "./server.ts";

// ---------- Decisions ----------

const PromptState = Schema.Struct({
  prompt: Schema.String,
  repository: Schema.String,
});

const definition = Decision.make({
  input: PromptState,
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

const state = {
  prompt: "Rename the credential store's update method to refresh and fix every caller.",
  repository: "Tau, a coding agent written in TypeScript with Effect.",
};

const decideError = (description: string) =>
  AiError.make({ module: "OpenAiDecisions", method: "decide", reason: new AiError.InvalidOutputError({ description }) });

/** OpenAI's Decisions API (`POST /v1/decisions`) behind Effect's `DecisionModel.make`. */
const openAiDecisions = (apiUrl: string, key: string, model: string) =>
  Layer.effect(
    DecisionModel.DecisionModel,
    Effect.gen(function* () {
      const client = (yield* HttpClient.HttpClient).pipe(
        HttpClient.mapRequest((request) =>
          request.pipe(HttpClientRequest.prependUrl(apiUrl), HttpClientRequest.bearerToken(key)),
        ),
        HttpClient.filterStatusOk,
      );

      return yield* DecisionModel.make({
        decide: ({ state, decisions }) =>
          Effect.gen(function* () {
            const questions = Object.entries(decisions).map(([name, decision]) => {
              switch (decision._tag) {
                case "Classify":
                  return {
                    type: "choice",
                    name,
                    instructions: decision.instructions,
                    choices: Object.entries(decision.criteria).map(([value, description]) => ({ value, description })),
                  };
                case "Rate":
                  return {
                    type: "score",
                    name,
                    instructions: decision.instructions,
                    levels: decision.criteria.map((label) => ({ label })),
                  };
                case "Probability":
                  return {
                    type: "predicate",
                    name,
                    instructions: decision.criteria
                      ? `${decision.instructions}\n\nTrue means: ${decision.criteria.true}\nFalse means: ${decision.criteria.false}`
                      : decision.instructions,
                  };
              }
            });

            const request = yield* HttpClientRequest.bodyJson(HttpClientRequest.post("/decisions"), {
              model,
              input: JSON.stringify(state),
              questions,
            }).pipe(Effect.orDie);
            const response = yield* client.execute(request).pipe(Effect.orDie);
            const body = (yield* response.json.pipe(Effect.orDie)) as any;

            const answers: Record<string, DecisionModel.ProviderAnswer> = {};
            for (const answer of body.answers ?? []) {
              const decision = decisions[answer.name];
              const distribution = Object.fromEntries(
                (answer.probabilities ?? []).map((entry: any) => [entry.label ?? entry.value, entry.probability]),
              );
              if (answer.type === "choice") {
                answers[answer.name] = { _tag: "Classify", label: answer.choice, probabilities: distribution, confidence: answer.confidence };
              } else if (answer.type === "score" && decision?._tag === "Rate") {
                answers[answer.name] = { _tag: "Rate", rating: answer.score, probabilities: distribution, confidence: answer.confidence };
              } else if (answer.type === "predicate") {
                answers[answer.name] = { _tag: "Probability", probability: answer.probability };
              } else {
                return yield* decideError(`unexpected answer ${JSON.stringify(answer).slice(0, 200)}`);
              }
            }

            return {
              answers,
              usage: { inputTokens: body.usage?.input_tokens, outputTokens: body.usage?.output_tokens },
            };
          }),
      });
    }),
  ).pipe(Layer.provide(FetchHttpClient.layer));

/** TypeSafe's System One protocol (`POST /systemone`), which OpenRouter serves, behind `DecisionModel.make`. */
const systemOne = (apiUrl: string, key: string, model: string) =>
  Layer.effect(
    DecisionModel.DecisionModel,
    Effect.gen(function* () {
      const client = (yield* HttpClient.HttpClient).pipe(
        HttpClient.mapRequest((request) =>
          request.pipe(HttpClientRequest.prependUrl(apiUrl), HttpClientRequest.bearerToken(key)),
        ),
        HttpClient.filterStatusOk,
      );

      return yield* DecisionModel.make({
        probabilityPrecision: 2,
        decide: ({ state, decisions }) =>
          Effect.gen(function* () {
            const questions = Object.fromEntries(
              Object.entries(decisions).map(([name, decision]) => {
                const type = decision._tag === "Classify" ? "choice" : decision._tag === "Rate" ? "score" : "noul";
                return [name, { type, instructions: decision.instructions, criteria: decision.criteria }];
              }),
            );

            const request = yield* HttpClientRequest.bodyJson(HttpClientRequest.post("/systemone"), {
              model,
              state,
              questions,
            }).pipe(Effect.orDie);
            const response = yield* client.execute(request).pipe(Effect.orDie);
            const body = (yield* response.json.pipe(Effect.orDie)) as any;

            const answers: Record<string, DecisionModel.ProviderAnswer> = {};
            for (const [name, answer] of Object.entries<any>(body.answers ?? {})) {
              const decision = decisions[name];
              if (answer.type === "choice") {
                answers[name] = { _tag: "Classify", label: answer.choice, probabilities: answer.probabilities, confidence: answer.confidence };
              } else if (answer.type === "score" && decision?._tag === "Rate") {
                const probabilities = Object.fromEntries(
                  decision.criteria.map((label, index) => [label, answer.probabilities?.[String(index)] ?? answer.probabilities?.[label]]),
                );
                answers[name] = { _tag: "Rate", rating: answer.score, probabilities, confidence: answer.confidence };
              } else if (answer.type === "noul") {
                answers[name] = { _tag: "Probability", probability: answer.noul };
              } else {
                return yield* decideError(`unexpected answer ${JSON.stringify(answer).slice(0, 200)}`);
              }
            }

            return {
              answers,
              usage: { inputTokens: body.usage?.input_tokens, outputTokens: body.usage?.output_tokens },
            };
          }),
      });
    }),
  ).pipe(Layer.provide(FetchHttpClient.layer));

const openRouterDecisions = (apiUrl: string, key: string, model: string) =>
  OpenRouterDecisionModel.layer({ model }).pipe(
    Layer.provide(OpenRouterClient.layer({ apiUrl, apiKey: Redacted.make(key) })),
    Layer.provide(FetchHttpClient.layer),
  );

const decide = (layer: Layer.Layer<DecisionModel.DecisionModel>) =>
  DecisionModel.decide(definition, { input: state }).pipe(Effect.provide(layer)) as Effect.Effect<any, unknown>;

// ---------- Chat routes ----------

const CLAUDE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";
const SYSTEM = "You are a coding agent. To compute anything, call the run tool with a JavaScript script.";

const bearer = (headers: Record<string, string>) => (client: HttpClient.HttpClient) =>
  HttpClient.mapRequest(client, (request) => HttpClientRequest.setHeaders(request, headers));

const claude = (apiUrl: string, token: string) =>
  AnthropicLanguageModel.layer({
    model: "claude-sonnet-5-5",
    config: { max_tokens: 4096 } as never,
  }).pipe(
    Layer.provide(
      AnthropicClient.layer({
        apiUrl,
        transformClient: (client) =>
          HttpClient.mapRequest(client, (request) =>
            HttpClientRequest.setHeaders(request, {
              authorization: `Bearer ${token}`,
              "anthropic-beta": [request.headers["anthropic-beta"], "claude-code-20250219", "oauth-2025-04-20"]
                .filter(Boolean)
                .join(","),
            }),
          ),
      }),
    ),
    Layer.provide(FetchHttpClient.layer),
  );

const jsonBody = (request: HttpClientRequest.HttpClientRequest): any => {
  const body: any = request.body;
  if (body._tag !== "Uint8Array") return undefined;
  return JSON.parse(body.text ?? new TextDecoder().decode(body.body));
};

/** Codex only streams. Turns a non-streaming request into a streaming one and answers with the completed response. */
const collectStream = (client: HttpClient.HttpClient): HttpClient.HttpClient => {
  const streaming = HttpClient.mapRequest(client, (request) => {
    const body = jsonBody(request);
    return body === undefined || body.stream === true
      ? request
      : HttpClientRequest.bodyJsonUnsafe(request, { ...body, stream: true }).pipe(
          HttpClientRequest.setHeader("x-tau-collect-stream", "1"),
        );
  });

  // `transform` sees the request after `mapRequest`, so the header marks requests that were not streaming.
  return HttpClient.transform(streaming, (effect, request) => {
    if (request.headers["x-tau-collect-stream"] !== "1") return effect;
    return Effect.flatMap(effect, (response) =>
      Effect.map(response.text, (text) => {
        const events = text
          .split("\n")
          .filter((line) => line.startsWith("data: "))
          .map((line) => {
            try {
              return JSON.parse(line.slice(6));
            } catch {
              return null;
            }
          });
        const completed = events.find((event) => event?.type === "response.completed")?.response;
        const items = events.filter((event) => event?.type === "response.output_item.done").map((event) => event.item);
        // Codex adds `phase: "commentary"` messages before the final answer; only the final answer is the object.
        const output = (completed?.output?.length ? completed.output : items).filter(
          (item: any) => item.type !== "message" || item.phase !== "commentary",
        );
        const result = completed === undefined ? {} : { ...completed, output };
        return HttpClientResponse.fromWeb(
          request,
          new Response(JSON.stringify(result), { status: response.status, headers: { "content-type": "application/json" } }),
        );
      }),
    );
  });
};

const codex = (apiUrl: string, token: string, accountId: string) =>
  OpenAiLanguageModel.layer({
    model: "gpt-6-luna",
    config: { store: false, instructions: SYSTEM, include: ["reasoning.encrypted_content"] } as never,
  }).pipe(
    Layer.provide(
      OpenAiClient.layer({
        apiUrl,
        transformClient: (client) =>
          collectStream(
            bearer({
              authorization: `Bearer ${token}`,
              "chatgpt-account-id": accountId,
              originator: "tau",
              "OpenAI-Beta": "responses=experimental",
            })(client),
          ),
      }),
    ),
    Layer.provide(FetchHttpClient.layer),
  );

const openAiKey = (apiUrl: string, key: string) =>
  OpenAiLanguageModel.layer({
    model: "gpt-6-luna",
    config: { store: false, include: ["reasoning.encrypted_content"], reasoning: { effort: "low", summary: "auto" } } as never,
  }).pipe(
    Layer.provide(OpenAiClient.layer({ apiUrl, apiKey: Redacted.make(key) })),
    Layer.provide(FetchHttpClient.layer),
  );

const compatRouter = (apiUrl: string, key: string) =>
  CompatLanguageModel.layer({ model: "anthropic/claude-haiku-5.5", config: { max_output_tokens: 4096 } as never }).pipe(
    Layer.provide(CompatClient.layer({ apiUrl, apiKey: Redacted.make(key) })),
    Layer.provide(FetchHttpClient.layer),
  );

const nativeRouter = (apiUrl: string, key: string) =>
  OpenRouterLanguageModel.layer({
    model: "anthropic/claude-haiku-5.5",
    config: {
      reasoning: { effort: "high" },
      max_tokens: 4096,
      provider: { require_parameters: true },
      strictJsonSchema: true,
    } as never,
  }).pipe(
    Layer.provide(OpenRouterClient.layer({ apiUrl, apiKey: Redacted.make(key) })),
    Layer.provide(FetchHttpClient.layer),
  );

// ---------- Turns ----------

const RunTool = Tool.dynamic("run", {
  description: "Run a JavaScript script and return what it prints.",
  parameters: { type: "object", properties: { script: { type: "string" } }, required: ["script"], additionalProperties: false },
});

const toolkit = Toolkit.make(RunTool);

const firstTurn = (identity: boolean) =>
  Prompt.make([
    ...(identity ? [{ role: "system" as const, content: CLAUDE_IDENTITY }] : []),
    { role: "system" as const, content: SYSTEM },
    {
      role: "user" as const,
      content:
        "First reason carefully about whether JavaScript numbers can represent (2^61 - 17) * 3 exactly. Then compute it with the run tool.",
    },
  ]);

const stream = (layer: Layer.Layer<LanguageModel.LanguageModel>, prompt: Prompt.Prompt) =>
  LanguageModel.streamText({ prompt, toolkit: toolkit as never, disableToolCallResolution: true }).pipe(
    Stream.runCollect,
    Effect.provide(layer),
  ) as Effect.Effect<readonly any[], unknown>;

const summarize = (parts: readonly any[]) => {
  let text = "";
  let reasoning = "";
  const types: string[] = [];
  const toolCalls: unknown[] = [];
  let finish: unknown;
  for (const part of parts) {
    if (types.at(-1) !== part.type) types.push(part.type);
    if (part.type === "text-delta") text += part.delta;
    if (part.type === "reasoning-delta") reasoning += part.delta;
    if (part.type === "tool-call") toolCalls.push({ name: part.name, params: part.params });
    if (part.type === "finish") finish = { reason: part.reason, usage: part.usage };
  }
  return { types, text, reasoning: reasoning.slice(0, 200), toolCalls, finish };
};

const history = (prompt: Prompt.Prompt, parts: readonly any[]) => {
  const call = parts.find((part) => part.type === "tool-call");
  const result = Prompt.make([
    {
      role: "tool",
      content: [{ type: "tool-result", id: call.id, name: call.name, isFailure: false, result: "6917529027641081805" }],
    },
  ]);
  return Prompt.concat(Prompt.concat(prompt, Prompt.fromResponseParts(parts)), result);
};

const Review = Schema.Struct({
  risk: Schema.Literals(["low", "medium", "high"]),
  files: Schema.Array(Schema.String),
  summary: Schema.String,
});

const object = (layer: Layer.Layer<LanguageModel.LanguageModel>, identity: boolean) =>
  LanguageModel.generateObject({
    objectName: "review",
    schema: Review,
    prompt: Prompt.make([
      ...(identity ? [{ role: "system" as const, content: CLAUDE_IDENTITY }] : []),
      {
        role: "user" as const,
        content:
          "Review this change: renamed `update` to `refresh` in src/ai/credential.ts and src/host/credential-store.ts. Give the risk, the files, and a one-line summary.",
      },
    ]),
  }).pipe(
    Effect.map((response) => response.value),
    Effect.provide(layer),
  ) as Effect.Effect<unknown, unknown>;

const outcome = <A>(effect: Effect.Effect<A, unknown>) =>
  effect.pipe(
    Effect.map((value) => ({ ok: true as const, value })),
    Effect.catchCause((cause) => Effect.succeed({ ok: false as const, error: String(cause).slice(0, 800) })),
  );

/** How each request asked for structured output, read from the body the proxy saw. */
const outputMechanism = (request: any) => {
  if (request === null || request === undefined) return "no request";
  if (request.output_config?.format) return `anthropic output_config.format (${request.output_config.format.type})`;
  if (request.output_format) return "anthropic output_format";
  if (request.text?.format?.type) return `responses text.format (${request.text.format.type})`;
  if (request.response_format?.type) return `chat response_format (${request.response_format.type})`;
  if (request.tool_choice) return `forced tool (${JSON.stringify(request.tool_choice).slice(0, 80)})`;
  return "unknown";
};

// ---------- Live ----------

const live = Effect.gen(function* () {
  const auth = JSON.parse(readFileSync(join(homedir(), ".pi/agent/auth.json"), "utf8"));
  const secrets: string[] = [
    auth.anthropic.access,
    auth.anthropic.refresh,
    auth["openai-codex"].access,
    auth["openai-codex"].refresh,
    auth["openai-codex"].accountId,
    auth.openrouter.key,
    auth.openai.key,
  ];

  const routerProxy = recordingProxy("https://openrouter.ai/api/v1");
  const openAiProxy = recordingProxy("https://api.openai.com/v1");
  const anthropicProxy = recordingProxy("https://api.anthropic.com");
  const codexProxy = recordingProxy("https://chatgpt.com/backend-api");
  const results: Record<string, unknown> = {};

  const record = (name: string, proxy: ReturnType<typeof recordingProxy>, before: number, value: unknown) => {
    const exchange = proxy.exchanges[before];
    if (exchange !== undefined) save(name, exchange, secrets);
    saveJson(`${name}.summary`, value);
  };

  // Cases 8, 9: decisions.
  const decisionRoutes = [
    ["decision-jev-openrouter", openRouterDecisions(routerProxy.url, auth.openrouter.key, "~typesafe/jev-latest"), routerProxy],
    ["decision-luna-openai", openAiDecisions(openAiProxy.url, auth.openai.key, "gpt-6-luna"), openAiProxy],
    ["decision-jev-systemone", systemOne(routerProxy.url, auth.openrouter.key, "~typesafe/jev-latest"), routerProxy],
    ["decision-luna-systemone", systemOne(routerProxy.url, auth.openrouter.key, "openai/gpt-6-luna-decisions"), routerProxy],
  ] as const;

  for (const [name, layer, proxy] of decisionRoutes) {
    const before = proxy.exchanges.length;
    const result = yield* outcome(decide(layer));
    results[name] = result;
    if (result.ok) record(name, proxy, before, result.value);
    else results[`${name}:response`] = proxy.exchanges[before]?.body.slice(0, 600);
  }

  // Case 9b: the Decisions API with a ChatGPT subscription token, expected to be refused.
  const codexDecision = yield* outcome(decide(openAiDecisions(openAiProxy.url, auth["openai-codex"].access, "gpt-6-luna")));
  results["decision-luna-openai with subscription token"] = codexDecision.ok
    ? "accepted"
    : openAiProxy.exchanges.at(-1)?.body.slice(0, 300);

  // Case 10: OpenAI API-key route, streaming with a tool call, then replayed.
  const keyRoute = openAiKey(openAiProxy.url, auth.openai.key);
  const keyBefore = openAiProxy.exchanges.length;
  const keyTurn = yield* outcome(stream(keyRoute, firstTurn(false)));
  results["openai-key"] = keyTurn.ok ? summarize(keyTurn.value) : keyTurn;
  if (keyTurn.ok) {
    record("openai-key", openAiProxy, keyBefore, summarize(keyTurn.value));
    const replayed = yield* outcome(stream(keyRoute, history(firstTurn(false), keyTurn.value)));
    results["openai-key replay"] = replayed.ok ? summarize(replayed.value).text.slice(0, 120) : replayed;
  }

  // Case 11: structured output on every chat route.
  const objectRoutes = [
    ["object-claude-subscription", claude(anthropicProxy.url, auth.anthropic.access), anthropicProxy, true],
    ["object-codex", codex(`${codexProxy.url}/codex`, auth["openai-codex"].access, auth["openai-codex"].accountId), codexProxy, false],
    ["object-openai-key", openAiKey(openAiProxy.url, auth.openai.key), openAiProxy, false],
    ["object-openrouter-compat", compatRouter(routerProxy.url, auth.openrouter.key), routerProxy, false],
    ["object-openrouter-native", nativeRouter(routerProxy.url, auth.openrouter.key), routerProxy, false],
  ] as const;

  for (const [name, layer, proxy, identity] of objectRoutes) {
    const before = proxy.exchanges.length;
    const result = yield* outcome(object(layer, identity));
    const exchange = proxy.exchanges[before];
    results[name] = { ...result, mechanism: outputMechanism(exchange?.request), status: exchange?.status };
    if (result.ok) record(name, proxy, before, result.value);
    else {
      results[`${name}:response`] = exchange?.body.slice(0, 400);
      yield* Effect.promise(() => Bun.write(`/tmp/more-${name}.txt`, exchange?.body ?? ""));
    }
  }

  // Case 12: OpenRouter's own chat package keeps Claude's reasoning details on replay.
  const native = nativeRouter(routerProxy.url, auth.openrouter.key);
  const nativeBefore = routerProxy.exchanges.length;
  const nativeTurn = yield* outcome(stream(native, firstTurn(false)));
  results["openrouter-native"] = nativeTurn.ok ? summarize(nativeTurn.value) : nativeTurn;
  if (nativeTurn.ok) {
    record("openrouter-native", routerProxy, nativeBefore, summarize(nativeTurn.value));
    const replayed = yield* outcome(stream(native, history(firstTurn(false), nativeTurn.value)));
    const sent = JSON.stringify(routerProxy.exchanges.at(-1)?.request ?? null);
    results["openrouter-native replay"] = {
      ok: replayed.ok,
      error: replayed.ok ? undefined : replayed.error,
      carriesReasoningDetails: sent.includes("reasoning_details"),
      carriesSignature: sent.includes('"signature"'),
    };
  }

  saveJson("more-live-results", results);
  for (const proxy of [routerProxy, openAiProxy, anthropicProxy, codexProxy]) proxy.stop();
  return results;
});

// ---------- Replay (case 13) ----------

const replay = Effect.gen(function* () {
  const results: Record<string, unknown> = {};

  const replayed = (name: string, run: (url: string) => Effect.Effect<unknown, unknown>, shape: (value: any) => unknown) =>
    Effect.gen(function* () {
      let recording;
      try {
        recording = load(name);
      } catch {
        results[name] = "no recording";
        return;
      }
      const server = replayServer(recording);
      const value = yield* outcome(run(server.url));
      server.stop();
      const expected = loadJson(`${name}.summary`);
      results[name] = value.ok
        ? JSON.stringify(shape(value.value)) === JSON.stringify(expected)
          ? "same as live"
          : { replayed: shape(value.value), expected }
        : value;
    });

  const same = (value: unknown) => JSON.parse(JSON.stringify(value));
  yield* replayed("decision-jev-systemone", (url) => decide(systemOne(url, "key", "~typesafe/jev-latest")), same);
  yield* replayed("decision-luna-systemone", (url) => decide(systemOne(url, "key", "openai/gpt-6-luna-decisions")), same);
  yield* replayed("decision-luna-openai", (url) => decide(openAiDecisions(url, "key", "gpt-6-luna")), same);
  yield* replayed("openai-key", (url) => stream(openAiKey(url, "key"), firstTurn(false)), summarize);
  yield* replayed("openrouter-native", (url) => stream(nativeRouter(url, "key"), firstTurn(false)), summarize);
  yield* replayed("object-claude-subscription", (url) => object(claude(url, "token"), true), same);
  yield* replayed("object-codex", (url) => object(codex(`${url}/codex`, "token", "account"), false), same);
  yield* replayed("object-openai-key", (url) => object(openAiKey(url, "key"), false), same);
  yield* replayed("object-openrouter-compat", (url) => object(compatRouter(url, "key"), false), same);
  yield* replayed("object-openrouter-native", (url) => object(nativeRouter(url, "key"), false), same);
  return results;
});

/** Re-runs only the structured-output cases that needed a fix. */
const objects = Effect.gen(function* () {
  const auth = JSON.parse(readFileSync(join(homedir(), ".pi/agent/auth.json"), "utf8"));
  const secrets: string[] = [auth["openai-codex"].access, auth["openai-codex"].refresh, auth["openai-codex"].accountId, auth.openrouter.key];
  const routerProxy = recordingProxy("https://openrouter.ai/api/v1");
  const codexProxy = recordingProxy("https://chatgpt.com/backend-api");
  const results: Record<string, unknown> = {};
  const routes = [
    ["object-codex", codex(`${codexProxy.url}/codex`, auth["openai-codex"].access, auth["openai-codex"].accountId), codexProxy],
    ["object-openrouter-native", nativeRouter(routerProxy.url, auth.openrouter.key), routerProxy],
  ] as const;
  for (const [name, layer, proxy] of routes) {
    const before = proxy.exchanges.length;
    const result = yield* outcome(object(layer, false));
    const exchange = proxy.exchanges[before];
    results[name] = {
      ...result,
      provider: exchange?.request && (exchange.request as any).provider,
      strict: (exchange?.request as any)?.response_format?.json_schema?.strict,
      routedTo: exchange?.body.match(/"provider":"([^"]+)"/)?.[1],
    };
    if (result.ok && exchange !== undefined) {
      save(name, exchange, secrets);
      saveJson(`${name}.summary`, result.value);
    }
  }
  routerProxy.stop();
  codexProxy.stop();
  return results;
});

const mode = Bun.argv[2];
const program =
  mode === "live" ? live : mode === "replay" ? replay : mode === "objects" ? objects : Effect.die("usage: more.ts live|replay|objects");
console.log(JSON.stringify(await Effect.runPromise(program as Effect.Effect<unknown, unknown>), null, 2));
