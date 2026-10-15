// Question: do the provider-side web search tools work through Tau's own routes (Claude
// subscription, Codex, ChatGPT app, OpenAI key) on each provider's small model, and does Exa's
// hosted MCP endpoint answer without a key?
//
// Uses the credentials `tau login` saved in ~/.tau. Saves each raw reply to recordings/ for the
// tests; never prints a token.
import { homedir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { AnthropicTool } from "@effect/ai-anthropic";
import { OpenAiTool } from "@effect/ai-openai";
import { Effect, Layer } from "effect";
import { Prompt, Toolkit } from "effect/ai";
import { FetchHttpClient } from "effect/http";
import { Catalog } from "../../src/ai/Catalog.ts";
import { ConversationId } from "../../src/ai/ConversationId.ts";
import { Models } from "../../src/ai/Models.ts";
import { ProviderId } from "../../src/ai/Providers.ts";
import { TauHome } from "../../src/database/TauHome.ts";
import { catalogCacheLayer } from "../../src/host/CatalogCache.ts";
import { credentialStoreLayer } from "../../src/host/CredentialStore.ts";
import { Settings } from "../../src/host/Settings.ts";

const recordings: Array<{ url: string; status: number; contentType: string; body: string }> = [];
const realFetch = globalThis.fetch;

globalThis.fetch = Object.assign(
  async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const response = await realFetch(input, init);
    const body = await response.text();
    recordings.push({
      url,
      status: response.status,
      contentType: response.headers.get("content-type") ?? "",
      body,
    });
    return new Response(body, { status: response.status, headers: response.headers });
  },
  { preconnect: realFetch.preconnect },
);

const routes = [
  { provider: "anthropic", model: "claude-sonnet-5-5", search: "anthropic" },
  { provider: "codex", model: "gpt-6-luna", search: "openai" },
  { provider: "chatgpt", model: "gpt-6-luna", search: "openai" },
  { provider: "openai", model: "gpt-6-luna", search: "openai" },
] as const;

const query = "What is the latest released version of the Bun JavaScript runtime?";

const appLayer = Models.layer.pipe(
  Layer.provideMerge(Catalog.layer),
  Layer.provideMerge(Layer.mergeAll(credentialStoreLayer, catalogCacheLayer, FetchHttpClient.layer)),
  Layer.provideMerge(Settings.layer),
  Layer.provideMerge(TauHome.at(join(homedir(), ".tau"))),
  Layer.provideMerge(BunServices.layer),
);

const save = (name: string, from: number) =>
  Effect.promise(() =>
    Bun.write(
      `${import.meta.dir}/recordings/${name}.json`,
      JSON.stringify(recordings.slice(from), null, 2),
    ),
  );

const hosted = Effect.fn("hosted")(function* (route: (typeof routes)[number]) {
  const models = yield* Models;
  const from = recordings.length;
  const small = yield* models.smallModel({
    provider: ProviderId.make(route.provider),
    model: route.model,
  });
  const languageModel = yield* models.languageModel(small, ConversationId.make(crypto.randomUUID()));

  const tool =
    route.search === "anthropic"
      ? AnthropicTool.WebSearch_20250305({ maxUses: 3 })
      : OpenAiTool.WebSearch({});

  const started = Date.now();
  const response = yield* languageModel.generateText({
    prompt: Prompt.fromMessages([
      Prompt.systemMessage({
        content:
          "Search the public web to answer the query. Use web search; do not answer from memory. Answer briefly with inline Markdown source links.",
      }),
      Prompt.userMessage({ content: [Prompt.textPart({ text: query })] }),
    ]),
    toolkit: Toolkit.make(tool),
    toolChoice: "required",
  });

  const sources = response.content.filter((part) => part.type === "source");
  console.log(`\n== ${route.provider} (${small.model}) ${Date.now() - started} ms`);
  console.log(response.text.slice(0, 600));
  console.log("parts:", [...new Set(response.content.map((part) => part.type))].join(", "));
  console.log(
    "sources:",
    sources.map((part) => ("url" in part ? part.url : part.title)).slice(0, 5),
  );
  yield* save(route.provider, from);
});

const exa = Effect.gen(function* () {
  const from = recordings.length;
  const started = Date.now();
  const response = yield* Effect.promise(() =>
    fetch("https://mcp.exa.ai/mcp", {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "web_search_exa", arguments: { query, numResults: 3 } },
      }),
    }),
  );
  const body = yield* Effect.promise(() => response.text());
  console.log(`\n== exa ${response.status} ${Date.now() - started} ms`);
  console.log(body.slice(0, 800));
  yield* save("exa", from);
});

const program = Effect.gen(function* () {
  const only = process.argv[2];
  for (const route of routes) {
    if (only !== undefined && only !== route.provider) continue;
    yield* hosted(route).pipe(
      Effect.catchCause((cause) =>
        Effect.sync(() => console.log(`\n== ${route.provider} FAILED\n${String(cause).slice(0, 800)}`)),
      ),
    );
  }
  if (only === undefined || only === "exa") yield* exa;
});

await Effect.runPromise(program.pipe(Effect.provide(appLayer)));
