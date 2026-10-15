import { describe, expect, test } from "bun:test";
import { BunCrypto, BunFileSystem } from "@effect/platform-bun";
import {
  ConfigProvider,
  Context,
  DateTime,
  Duration,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Redacted,
  Schema,
  type Scope,
} from "effect";
import { Base64Url } from "effect/encoding";
import { FetchHttpClient } from "effect/http";
import { TestClock } from "effect/testing";
import { Catalog, type ModelRef } from "../../src/ai/Catalog.ts";
import { ConversationId } from "../../src/ai/ConversationId.ts";
import { ApiKey, CredentialStore, OAuthTokens } from "../../src/ai/Credential.ts";
import { Models } from "../../src/ai/Models.ts";
import { ProviderId } from "../../src/ai/Providers.ts";
import { Web } from "../../src/core/Web.ts";
import { TauHome } from "../../src/database/TauHome.ts";
import { catalogCacheLayer } from "../../src/host/CatalogCache.ts";
import { credentialStoreLayer } from "../../src/host/CredentialStore.ts";
import { Settings } from "../../src/host/Settings.ts";

const Recording = Schema.Struct({
  status: Schema.Number,
  contentType: Schema.String,
  body: Schema.String,
});

type Reply = typeof Recording.Type;

const recording = (name: string) =>
  Effect.promise(() => Bun.file(`${import.meta.dir}/../recordings/${name}.json`).text()).pipe(
    Effect.map(Schema.decodeUnknownSync(Schema.fromJsonString(Recording))),
  );

const page = (contentType: string, body: string): Reply => ({ status: 200, contentType, body });

/**
 * Every request goes to a local server, which answers by path and keeps the paths it got. The
 * HTTP client sends each request there, whatever its host, so Exa's fixed address is covered too.
 */
const localWeb = (replies: Record<string, Reply>) =>
  Effect.gen(function* () {
    const paths: string[] = [];

    const server = yield* Effect.acquireRelease(
      Effect.sync(() =>
        Bun.serve({
          port: 0,
          fetch: (request) => {
            const path = new URL(request.url).pathname;
            paths.push(path);
            const reply = replies[path];
            if (reply === undefined) return new Response("not found", { status: 404 });

            return new Response(reply.body, {
              status: reply.status,
              headers: { "content-type": reply.contentType },
            });
          },
        }),
      ),
      (running) => Effect.promise(() => running.stop(true)),
    );

    const local: typeof globalThis.fetch = Object.assign(
      (input: RequestInfo | URL, init?: RequestInit) => {
        const { pathname } = new URL(input instanceof Request ? input.url : input);
        return fetch(`http://localhost:${server.port}${pathname}`, init);
      },
      { preconnect: fetch.preconnect },
    );

    const client = FetchHttpClient.layer.pipe(
      Layer.provide(Layer.succeed(FetchHttpClient.Fetch, local)),
    );

    return { client, paths };
  });

const HOUR_MILLIS = 3_600_000;

/** Codex reads the ChatGPT account from the token's payload. */
const accountClaim = Base64Url.encode(
  JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "account-123" } }),
);

const login = OAuthTokens.make({
  access: Redacted.make(`header.${accountClaim}.signature`),
  refresh: Redacted.make("refresh"),
  expiresAt: DateTime.makeUnsafe(Date.now() + HOUR_MILLIS),
});

/** The Web service over the real models and catalog, logged in to every provider. */
const withWeb = <A, E>(
  replies: Record<string, Reply>,
  program: (web: Web["Service"], paths: readonly string[]) => Effect.Effect<A, E, Scope.Scope>,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const home = TauHome.at(`${yield* fileSystem.makeTempDirectoryScoped()}/.tau`);
    const { client, paths } = yield* localWeb(replies);

    const storeLayer = credentialStoreLayer.pipe(Layer.provide(home));
    const store = Context.get(yield* Layer.build(storeLayer), CredentialStore);
    yield* store.save(ProviderId.make("anthropic"), login);
    yield* store.save(ProviderId.make("codex"), login);
    yield* store.save(ProviderId.make("openai"), ApiKey.make({ key: Redacted.make("openai-key") }));

    const catalog = Catalog.layer.pipe(
      Layer.provide(Settings.layer.pipe(Layer.provide(home))),
      Layer.provide(catalogCacheLayer.pipe(Layer.provide(home))),
      Layer.provide(BunCrypto.layer),
    );

    const layer = Web.layer.pipe(
      Layer.provideMerge(Models.layer),
      Layer.provideMerge(catalog),
      Layer.provide(storeLayer),
      Layer.provide(client),
      Layer.provide(
        ConfigProvider.layer(ConfigProvider.fromUnknown({ OPENROUTER_API_KEY: "openrouter-key" })),
      ),
      Layer.provide(BunFileSystem.layer),
    );

    const web = Context.get(yield* Layer.build(layer), Web);
    return yield* program(web, paths);
  });

const run = <A, E>(program: Effect.Effect<A, E, Scope.Scope | FileSystem.FileSystem>) =>
  Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(BunFileSystem.layer)));

const runExit = <A, E>(program: Effect.Effect<A, E, Scope.Scope | FileSystem.FileSystem>) =>
  Effect.runPromiseExit(program.pipe(Effect.scoped, Effect.provide(BunFileSystem.layer)));

const ref = (provider: string, model: string): ModelRef => ({
  provider: ProviderId.make(provider),
  model,
});

const query = { query: "latest Bun version", maxSources: 3, timeout: Duration.seconds(20) };
const conversation = ConversationId.make("session-1:web");

describe("web search", () => {
  test("a Claude session searches with Claude's search tool on the small model", async () => {
    const replies = { "/v1/messages": await run(recording("anthropic-web-search")) };

    const { result, paths } = await run(
      withWeb(replies, (web, paths) =>
        web
          .search(ref("anthropic", "claude-sonnet-5-5"), conversation, query)
          .pipe(Effect.map((result) => ({ result, paths: [...paths] }))),
      ),
    );

    expect(result.route).toBe("anthropic");
    expect(result.fellBack).toBeUndefined();
    expect(result.text).toContain("1.4.3");
    expect(result.sources.length).toBe(3);
    expect(result.sources[0]?.title).not.toBe("");
    expect(paths).toEqual(["/v1/messages"]);
  });

  test("a Codex session searches with OpenAI's search tool and gets sources from the tool result", async () => {
    const replies = {
      "/backend-api/codex/responses": await run(recording("codex-web-search")),
    };

    const result = await run(
      withWeb(replies, (web) => web.search(ref("codex", "gpt-6-luna"), conversation, query)),
    );

    expect(result.route).toBe("openai");
    expect(result.text).toContain("1.4.3");
    expect(result.sources.map(({ url }) => url)).toContain("https://bun.com/blog");
  });

  test("a provider without its own search uses Exa", async () => {
    // Exa's success reply has the shape of its live rate-limited reply, with a result inside.
    const replies = { "/mcp": await run(recording("exa-search")) };

    const result = await run(
      withWeb(replies, (web) =>
        web.search(ref("openrouter", "deepseek/deepseek-v4.1-flash"), conversation, query),
      ),
    );

    expect(result).toEqual({
      text: expect.stringContaining("Bun v1.4.3 is out."),
      sources: [
        { url: "https://bun.com/blog/bun-v1.4.3", title: "Bun v1.4.3" },
        { url: "https://github.com/oven-sh/bun/releases", title: "Bun releases" },
      ],
      route: "exa",
      fellBack: undefined,
    });
  });

  test("a failed provider search falls back to Exa and says why", async () => {
    const replies = {
      "/v1/responses": { status: 500, contentType: "application/json", body: "{}" },
      "/mcp": await run(recording("exa-search")),
    };

    const result = await run(
      withWeb(replies, (web) => web.search(ref("openai", "gpt-6-luna"), conversation, query)),
    );

    expect(result.route).toBe("exa");
    expect(result.fellBack).toBe("failed");
  });

  test("Exa searches start at least 2 s apart", async () => {
    const replies = { "/mcp": await run(recording("exa-search")) };
    const openRouter = ref("openrouter", "deepseek/deepseek-v4.1-flash");

    const started = await run(
      withWeb(replies, (web, paths) =>
        Effect.gen(function* () {
          const first = yield* Effect.forkChild(web.search(openRouter, conversation, query));
          const second = yield* Effect.forkChild(web.search(openRouter, conversation, query));
          yield* Fiber.join(first);
          const beforeTwoSeconds = paths.length;

          yield* TestClock.adjust(Duration.seconds(2));
          yield* Fiber.join(second);
          return [beforeTwoSeconds, paths.length];
        }),
      ).pipe(Effect.provide(TestClock.layer())),
    );

    expect(started).toEqual([1, 2]);
  });

  test("Exa's rate-limited reply is a failure that asks for a key", async () => {
    const replies = { "/mcp": await run(recording("exa-rate-limited")) };

    const exit = await runExit(
      withWeb(replies, (web) =>
        web.search(ref("openrouter", "deepseek/deepseek-v4.1-flash"), conversation, query),
      ),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    expect(String(exit)).toContain("EXA_API_KEY");
  });
});

describe("web fetch", () => {
  const html = `<!doctype html><html><head><title>T</title><style>p{}</style></head><body>
    <nav>Menu</nav><h1>Bun &amp; you</h1><p>Read the <a href="https://bun.com/docs">docs</a> now.</p>
    <script>alert(1)</script><ul><li>one</li><li>two&#x21;</li></ul></body></html>`;

  test("HTML becomes text with link addresses, without scripts or styles", async () => {
    const replies = { "/page": page("text/html; charset=utf-8", html) };

    const fetched = await run(
      withWeb(replies, (web) => web.fetch("https://example.com/page", Duration.seconds(5))),
    );

    expect(fetched.status).toBe(200);

    expect(fetched.text).toBe(
      "Menu\n\nBun & you\n\nRead the docs (https://bun.com/docs) now.\n\none\n\ntwo!",
    );
  });

  test("JSON comes back as it is", async () => {
    const replies = { "/data": page("application/json", '{"a":1}') };

    const fetched = await run(
      withWeb(replies, (web) => web.fetch("https://example.com/data", Duration.seconds(5))),
    );

    expect(fetched.text).toBe('{"a":1}');
  });

  test("a binary file is refused", async () => {
    const replies = { "/image": page("image/png", "png") };

    const exit = await runExit(
      withWeb(replies, (web) => web.fetch("https://example.com/image", Duration.seconds(5))),
    );

    expect(String(exit)).toContain("not text");
  });
});
