// Live check: which request headers make the ChatGPT plan routes read the prompt cache?
// Uses Tau's own Models with the logins saved in ~/.tau. Never prints a token or a request body.
import { homedir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import { LanguageModel, Prompt } from "effect/ai";
import { FetchHttpClient } from "effect/http";
import { Catalog } from "../../src/ai/Catalog.ts";
import { ConversationId } from "../../src/ai/ConversationId.ts";
import { Models } from "../../src/ai/Models.ts";
import { RouteId } from "../../src/ai/Routes.ts";
import { TauHome } from "../../src/database/TauHome.ts";
import { catalogCacheLayer } from "../../src/host/CatalogCache.ts";
import { credentialStoreLayer } from "../../src/host/CredentialStore.ts";
import { Settings } from "../../src/host/Settings.ts";

type HeaderVariant = { name: string; headers: (id: string) => Record<string, string> };

const allVariants: HeaderVariant[] = [
  { name: "body key only", headers: () => ({}) },
  { name: "session-id", headers: (id) => ({ "session-id": id }) },
  { name: "session_id", headers: (id) => ({ session_id: id }) },
  {
    name: "session-id + x-client-request-id",
    headers: (id) => ({ "session-id": id, "x-client-request-id": id }),
  },
];

// `repeat` compares only the two main variants, several times, with one more turn.
const isRepeat = process.argv[2] === "repeat";
const variants = isRepeat
  ? allVariants.filter((variant) => variant.name === "body key only" || variant.name === "session-id")
  : allVariants;
const conversationsPerCase = isRepeat ? 3 : 1;

const targets = [
  { route: "codex", model: "gpt-6-luna" },
  { route: "codex", model: "gpt-6.1-sol" },
  { route: "chatgpt", model: "gpt-6-luna" },
  { route: "chatgpt", model: "gpt-6.1-sol" },
];

// About 3,000 tokens of stable text, so every breakpoint is past the 1,024-token minimum.
const system = Array.from(
  { length: 150 },
  (_, i) =>
    `Rule ${i + 1}: when the user asks about subject number ${i + 1}, answer with one short sentence and name the subject number.`,
).join("\n");

const userTurns = [
  "Reply with one word: apple.",
  "Reply with one word: pear.",
  "Reply with one word: plum.",
  ...(isRepeat ? ["Reply with one word: fig."] : []),
];

// Set before each conversation; read by the fetch below.
let extraHeaders: Record<string, string> = {};
let requestBodies: string[] = [];
let responseBodies: string[] = [];

const capturingFetch: typeof fetch = Object.assign(
  async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.endsWith("/responses")) return fetch(input, init);
    const request = new Request(input, init);
    for (const [name, value] of Object.entries(extraHeaders)) request.headers.set(name, value);
    const body = await request.clone().text();
    requestBodies.push(body);
    const response = await fetch(request);
    const text = await response.text();
    responseBodies.push(text);
    return new Response(text, { status: response.status, headers: response.headers });
  },
  { preconnect: fetch.preconnect },
);

/** The usage object of the last `response.completed` event, or of a plain JSON reply. */
const rawUsage = (text: string) => {
  for (const line of text.split("\n").reverse()) {
    if (!line.startsWith("data: ")) continue;
    try {
      const event = JSON.parse(line.slice("data: ".length));
      if (event?.response?.usage) return event.response.usage;
    } catch {}
  }
  try {
    return JSON.parse(text)?.usage;
  } catch {
    return undefined;
  }
};

/** Where request `next` stops repeating request `previous` byte for byte. */
const prefixCheck = (previous: string, next: string) => {
  const a = JSON.parse(previous);
  const b = JSON.parse(next);
  const changedFields = Object.keys({ ...a, ...b }).filter(
    (key) => key !== "input" && JSON.stringify(a[key]) !== JSON.stringify(b[key]),
  );
  const firstChangedItem = a.input.findIndex(
    (item: unknown, i: number) => JSON.stringify(item) !== JSON.stringify(b.input[i]),
  );
  return {
    changedFields,
    firstChangedItem: firstChangedItem === -1 ? null : firstChangedItem,
    previousItems: a.input.length,
    nextItems: b.input.length,
    itemTypes: b.input.map((item: { type?: string; role?: string }) => item.role ?? item.type),
  };
};

const conversation = (route: string, model: string, variant: HeaderVariant) =>
  Effect.gen(function* () {
    const id = crypto.randomUUID();
    extraHeaders = variant.headers(id);
    requestBodies = [];
    responseBodies = [];
    const models = yield* Models;
    const languageModel = yield* models.languageModel(
      { route: RouteId.make(route), model },
      ConversationId.make(id),
    );
    // A unique first line keeps one conversation from reading another's cache.
    const content = isRepeat ? `Conversation ${id}.\n${system}` : system;
    let prompt = Prompt.make([{ role: "system", content }]);
    const calls = [];
    for (const turn of userTurns) {
      prompt = Prompt.concat(prompt, Prompt.make([{ role: "user", content: turn }]));
      const response = yield* LanguageModel.generateText({ prompt }).pipe(
        Effect.provideService(LanguageModel.LanguageModel, languageModel),
      );
      prompt = Prompt.concat(prompt, Prompt.fromResponseParts(response.content));
      const raw = rawUsage(responseBodies.at(-1) ?? "");
      calls.push({
        text: response.text.trim(),
        effect: response.usage.inputTokens,
        raw: { input: raw?.input_tokens, details: raw?.input_tokens_details },
      });
    }
    const prefixes = requestBodies.slice(1).map((body, i) => prefixCheck(requestBodies[i] ?? "{}", body));
    const firstBody = JSON.parse(requestBodies[0] ?? "{}");
    return {
      bodyFields: Object.keys(firstBody),
      cacheFields: { prompt_cache_key: firstBody.prompt_cache_key === id, prompt_cache_options: firstBody.prompt_cache_options },
      calls,
      prefixes,
    };
  });

const program = Effect.gen(function* () {
  const report: Record<string, unknown> = {};
  for (const { route, model } of targets) {
    for (const variant of variants) {
      for (let run = 1; run <= conversationsPerCase; run++) {
        const key = `${route}/${model} | ${variant.name} | ${run}`;
        const result = yield* Effect.result(conversation(route, model, variant));
        report[key] = result._tag === "Success" ? result.success : { error: String(result.failure) };
        console.error(key, JSON.stringify(report[key]).slice(0, 200));
      }
    }
  }
  return report;
});

const layer = Models.layer.pipe(
  Layer.provideMerge(Catalog.layer),
  Layer.provideMerge(Layer.mergeAll(credentialStoreLayer, catalogCacheLayer, Settings.layer, FetchHttpClient.layer)),
  Layer.provideMerge(Layer.succeed(FetchHttpClient.Fetch, capturingFetch)),
  Layer.provideMerge(TauHome.at(join(homedir(), ".tau"))),
  Layer.provideMerge(BunServices.layer),
);

const report = await Effect.runPromise(program.pipe(Effect.provide(layer)));
await Bun.write(
  `${import.meta.dir}/results${isRepeat ? "-repeat" : ""}.json`,
  JSON.stringify(report, null, 2),
);
console.log(JSON.stringify(report, null, 2));
