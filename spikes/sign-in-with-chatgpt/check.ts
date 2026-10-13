// Live calls with a Sign in with ChatGPT token through Effect's OpenAI package, against the public
// Responses API. Writes results.json (gitignored); never prints a token.
// Usage: bun check.ts [model]
import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai";
import { Effect, Layer, Schema, Stream } from "effect";
import { Decision, DecisionModel, LanguageModel, Tool, Toolkit } from "effect/ai";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { collectResponseStream } from "../../src/ai/responses-stream.ts";
import { openAiDecisionModel } from "../../src/ai/openai-decisions.ts";

const RESOURCE = "https://api.openai.com/v1";
const TOKEN_URL = "https://auth.openai.com/api/accounts/oauth/token";
const credentialsFile = Bun.file(`${import.meta.dir}/state/credentials.json`);
const credentials = await credentialsFile.json();

type Exchange = { url: string; requestFields: string[]; stream: unknown; status: number; error?: string };
const exchanges: Exchange[] = [];

const capturingFetch: typeof fetch = Object.assign(
  async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const sent = await request.clone().text();
    const response = await fetch(request);
    let fields: Record<string, unknown> = {};
    try { fields = JSON.parse(sent); } catch {}
    const exchange: Exchange = { url: request.url, requestFields: Object.keys(fields), stream: fields.stream, status: response.status };
    if (response.status >= 400) exchange.error = (await response.clone().text()).slice(0, 600);
    exchanges.push(exchange);
    return response;
  },
  { preconnect: fetch.preconnect },
);

// Model list first, so the calls use a model this account can reach.
const modelsResponse = await capturingFetch(`${RESOURCE}/models`, { headers: { authorization: `Bearer ${credentials.access_token}` } });
const modelsBody = await modelsResponse.json().catch(() => undefined);
const listed: string[] = (modelsBody?.models ?? modelsBody?.data ?? [])
  .filter((entry: { visibility?: string }) => entry.visibility === undefined || entry.visibility === "list")
  .map((entry: { slug?: string; id?: string }) => entry.slug ?? entry.id);
const decisionOnly = process.argv[2] === "decision";
const model = (decisionOnly ? undefined : process.argv[2]) ?? listed[0] ?? "gpt-6-luna";

const sign = (client: HttpClient.HttpClient) =>
  HttpClient.mapRequest(client, HttpClientRequest.bearerToken(credentials.access_token));

const languageModel = (collect: boolean) =>
  OpenAiLanguageModel.make({ model, config: { store: false, include: ["reasoning.encrypted_content"] } }).pipe(
    Effect.provideServiceEffect(
      OpenAiClient.OpenAiClient,
      OpenAiClient.make({
        apiUrl: RESOURCE,
        transformClient: collect ? (client) => collectResponseStream(sign(client)) : sign,
      }),
    ),
  );

const RunTool = Tool.make("run", {
  description: "Run a JavaScript script and return what it prints.",
  parameters: Schema.Struct({ script: Schema.String }),
  success: Schema.String,
});
const toolkit = Toolkit.make(RunTool);

const Review = Schema.Struct({ risk: Schema.Literals(["low", "medium", "high"]), summary: Schema.String });

const cases = {
  "generateText, as Effect sends it (not streamed)": Effect.gen(function* () {
    const response = yield* LanguageModel.generateText({ prompt: "Reply with exactly: ok" }).pipe(
      Effect.provideService(LanguageModel.LanguageModel, yield* languageModel(false)),
    );
    return response.text;
  }),
  "generateText through Tau's stream collector": Effect.gen(function* () {
    const response = yield* LanguageModel.generateText({ prompt: "Reply with exactly: ok" }).pipe(
      Effect.provideService(LanguageModel.LanguageModel, yield* languageModel(true)),
    );
    return response.text;
  }),
  "streamText with a system message": Effect.gen(function* () {
    const parts = yield* LanguageModel.streamText({
      prompt: [
        { role: "system", content: "You answer in one word." },
        { role: "user", content: "Reply with exactly: ok" },
      ],
    }).pipe(Stream.runCollect, Effect.provideService(LanguageModel.LanguageModel, yield* languageModel(false)));
    return parts.flatMap((part) => (part.type === "text-delta" ? [part.delta] : [])).join("");
  }),
  "streamText with a function tool": Effect.gen(function* () {
    const parts = yield* LanguageModel.streamText({
      prompt: "Compute (2^61 - 17) * 3 with the run tool.",
      toolkit,
      disableToolCallResolution: true,
    }).pipe(Stream.runCollect, Effect.provideService(LanguageModel.LanguageModel, yield* languageModel(false)));
    return parts.flatMap((part) => (part.type === "tool-call" ? [`${part.name} ${JSON.stringify(part.params)}`] : []));
  }),
  "generateObject through Tau's stream collector": Effect.gen(function* () {
    const response = yield* LanguageModel.generateObject({
      prompt: "Review the rename of `update` to `refresh` in a credential store.",
      schema: Review,
      objectName: "review",
    }).pipe(Effect.provideService(LanguageModel.LanguageModel, yield* languageModel(true)));
    return response.value;
  }),
};

const routeDecisions = Decision.make({
  input: Schema.Struct({ prompt: Schema.String }),
  decisions: {
    route: Decision.classify({
      instructions: "What kind of work does the prompt ask for?",
      criteria: { code: "Change or write code.", question: "Answer a question.", chat: "Small talk." },
    }),
  },
});

const decision = Effect.gen(function* () {
  const client = sign((yield* HttpClient.HttpClient).pipe(HttpClient.mapRequest(HttpClientRequest.prependUrl(RESOURCE))));
  const decisionModel = yield* openAiDecisionModel(client, "gpt-6-luna");
  return yield* DecisionModel.decide(routeDecisions, { input: { prompt: "Rename update to refresh." } }).pipe(
    Effect.provideService(DecisionModel.DecisionModel, decisionModel),
  );
});

const results: Record<string, unknown> = { model, listedModels: listed.slice(0, 15) };

if (decisionOnly) {
  const outcome = await Effect.runPromise(
    Effect.result(decision).pipe(Effect.provide(Layer.succeed(FetchHttpClient.Fetch, capturingFetch)), Effect.provide(FetchHttpClient.layer)),
  );
  const json = JSON.stringify({ outcome: outcome._tag === "Success" ? outcome.success : String(outcome.failure).slice(0, 400), exchanges: exchanges.slice(1) }, null, 2);
  await Bun.write(`${import.meta.dir}/results-decision.json`, json);
  console.log(json);
  process.exit(0);
}

for (const [name, program] of Object.entries(cases)) {
  const before = exchanges.length;
  const outcome = await Effect.runPromise(
    Effect.result(program).pipe(Effect.provide(Layer.succeed(FetchHttpClient.Fetch, capturingFetch)), Effect.provide(FetchHttpClient.layer)),
  );
  results[name] = {
    outcome: outcome._tag === "Success" ? outcome.success : String(outcome.failure).slice(0, 400),
    exchanges: exchanges.slice(before),
  };
}

// One refresh, saved back so the next run uses the rotated tokens.
const refreshResponse = await fetch(TOKEN_URL, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    grant_type: "refresh_token",
    client_id: credentials.client_id,
    refresh_token: credentials.refresh_token,
    resource: RESOURCE,
  }),
});
const refreshed = await refreshResponse.json();
results.refresh = {
  status: refreshResponse.status,
  fields: Object.keys(refreshed),
  refreshRotated: refreshed.refresh_token !== undefined && refreshed.refresh_token !== credentials.refresh_token,
  expiresIn: refreshed.expires_in,
  error: refreshResponse.ok ? undefined : refreshed,
};
if (refreshResponse.ok) {
  await Bun.write(credentialsFile, JSON.stringify({ ...credentials, ...refreshed, saved_at: new Date().toISOString() }, null, 2));
}

const json = JSON.stringify(results, (_key, value) => (typeof value === "bigint" ? String(value) : value), 2);
await Bun.write(`${import.meta.dir}/results.json`, json);
console.log(json);
