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
  Option,
  Redacted,
  Schema,
  type Scope,
} from "effect";
import { FetchHttpClient } from "effect/http";
import { TestClock } from "effect/testing";
import { Catalog, CatalogCache, type CatalogData, CatalogSources } from "../../src/ai/Catalog.ts";
import snapshot from "../../src/ai/catalog-snapshot.json" with { type: "json" };
import { type Credential, CredentialStore, OAuthTokens } from "../../src/ai/Credential.ts";
import { builtInProviders, ProviderId, ProviderTable } from "../../src/ai/Providers.ts";
import { TauHome } from "../../src/database/TauHome.ts";
import { catalogCacheLayer } from "../../src/host/CatalogCache.ts";
import { credentialStoreLayer } from "../../src/host/CredentialStore.ts";
import { Settings } from "../../src/host/Settings.ts";

const CODEX_CONTEXT_TOKENS = 272_000;
const NEW_CONTEXT_TOKENS = 123_456;

type Answer = () => Response | Promise<Response>;

/** Stands in for models.dev, npm and the Codex backend, and keeps the paths it was asked for. */
const fakeServer = (answers: Readonly<Record<string, Answer>>) =>
  Effect.gen(function* () {
    const received: string[] = [];

    const server = yield* Effect.acquireRelease(
      Effect.sync(() =>
        Bun.serve({
          port: 0,
          fetch: (request) => {
            const path = new URL(request.url).pathname;
            received.push(path);
            return answers[path]?.() ?? new Response("not found", { status: 404 });
          },
        }),
      ),
      (running) => Effect.promise(() => running.stop(true)),
    );

    return { url: `http://localhost:${server.port}`, received };
  });

const failing: Answer = () => new Response("unavailable", { status: 503 });
const json = (body: unknown) => () => Response.json(body);

const codexLogin = OAuthTokens.make({
  access: Redacted.make(
    `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "account" } })).toString("base64url")}.signature`,
  ),
  refresh: Redacted.make("refresh"),
  expiresAt: DateTime.makeUnsafe(Date.now() + Duration.toMillis(Duration.days(30))),
});

type Setup = {
  readonly serverUrl: string;
  readonly cache: CatalogData | undefined;
  readonly credentials: ReadonlyArray<readonly [string, Credential]>;
};

/** Builds the catalog over a temporary `~/.tau`, with every provider and source on the fake server. */
const withCatalog = <A, E>(
  setup: Setup,
  program: (catalog: Catalog["Service"], tauDirectory: string) => Effect.Effect<A, E, Scope.Scope>,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const tauDirectory = `${yield* fileSystem.makeTempDirectoryScoped()}/.tau`;

    const services = yield* Layer.build(
      Layer.merge(catalogCacheLayer, credentialStoreLayer).pipe(
        Layer.provide(TauHome.at(tauDirectory)),
        Layer.provide(BunCrypto.layer),
      ),
    );

    for (const [provider, credential] of setup.credentials)
      yield* Context.get(services, CredentialStore).save(ProviderId.make(provider), credential);

    if (setup.cache !== undefined) yield* Context.get(services, CatalogCache).write(setup.cache);

    const providers = builtInProviders.map((provider) => ({
      ...provider,
      apiUrl: provider.apiUrl.replace(/^https:\/\/[^/]+/, setup.serverUrl),
    }));

    const sources = {
      modelsDevUrl: `${setup.serverUrl}/api.json`,
      claudeCodeUrl: `${setup.serverUrl}/claude-code`,
    };

    const layer = Catalog.layer.pipe(
      Layer.provide(Layer.succeed(ProviderTable, { providers, settings: new Map() })),
      Layer.provide(Layer.succeed(CatalogSources, sources)),
      Layer.provide(Layer.succeedContext(services)),
      Layer.provide(FetchHttpClient.layer),
      Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
    );

    const catalog = Context.get(yield* Layer.build(layer), Catalog);
    return yield* program(catalog, tauDirectory);
  });

/** Runs `program` two days from now, so any catalog fetched today counts as stale. */
const run = <A, E>(program: Effect.Effect<A, E, Scope.Scope | FileSystem.FileSystem>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.now() + Duration.toMillis(Duration.days(2)));
      return yield* program;
    }).pipe(Effect.scoped, Effect.provide(Layer.merge(TestClock.layer(), BunFileSystem.layer))),
  );

const [firstClaudeId = "", firstClaude] =
  Object.entries(snapshot.modelsDev.anthropic.models)[0] ?? [];

/** A cache written by an older Tau: its date and models are older than the snapshot's. */
const oldCache = (claudeCodeVersion: string): CatalogData => ({
  fetchedAt: DateTime.makeUnsafe(0),
  claudeCodeVersion,
  modelsDev: {},
  liveModels: undefined,
});

const claudeNew = {
  id: "claude-new",
  name: "Claude New",
  reasoning: true,
  tool_call: true,
  limit: { context: NEW_CONTEXT_TOKENS, output: 64_000 },
};

const anthropicRef = (model: string) => ({ provider: ProviderId.make("anthropic"), model });
const codexRef = (model: string) => ({ provider: ProviderId.make("codex"), model });

describe("catalog", () => {
  test("with no cache and no refresh, the snapshot in the binary describes a model", () =>
    run(
      Effect.gen(function* () {
        const server = yield* fakeServer({});
        const setup = { serverUrl: server.url, cache: undefined, credentials: [] };

        const { profile } = yield* withCatalog(setup, (catalog) =>
          catalog.model(anthropicRef(firstClaudeId)),
        );

        expect(profile.contextTokens).toBe(firstClaude?.limit.context ?? -1);
        expect(profile.protocol).toBe("anthropic");
        expect(server.received).toHaveLength(0);
      }),
    ));

  test("a stale catalog refreshes while models still answer, then the new data wins", () =>
    run(
      Effect.gen(function* () {
        const held = Promise.withResolvers<void>();
        const asked = Promise.withResolvers<void>();

        const server = yield* fakeServer({
          "/api.json": async () => {
            asked.resolve();
            await held.promise;
            return Response.json({ anthropic: { models: { "claude-new": claudeNew } } });
          },
          "/claude-code": json({ version: "99.0.0" }),
        });

        const setup = { serverUrl: server.url, cache: undefined, credentials: [] };

        const tauDirectory = yield* withCatalog(setup, (catalog, directory) =>
          Effect.gen(function* () {
            const refresh = yield* Effect.forkChild(catalog.refreshIfStale);
            yield* Effect.promise(() => asked.promise);

            yield* catalog.model(anthropicRef(firstClaudeId));

            expect(
              Exit.isFailure(yield* Effect.exit(catalog.model(anthropicRef("claude-new")))),
            ).toBe(true);

            held.resolve();
            yield* Fiber.join(refresh);

            const { profile } = yield* catalog.model(anthropicRef("claude-new"));
            expect(profile.contextTokens).toBe(NEW_CONTEXT_TOKENS);
            expect(yield* catalog.claudeCodeVersion).toBe("99.0.0");
            return directory;
          }),
        );

        const cached = yield* Layer.build(
          catalogCacheLayer.pipe(Layer.provide(TauHome.at(tauDirectory))),
        ).pipe(
          Effect.provide(BunCrypto.layer),
          Effect.flatMap((services) => Context.get(services, CatalogCache).read),
        );

        expect(Option.map(cached, (data) => data.claudeCodeVersion)).toEqual(Option.some("99.0.0"));
      }),
    ));

  test.each([
    {
      npm: "answers below the floor",
      answer: json({ version: "0.0.1" }),
      expected: snapshot.claudeCodeVersion,
    },
    { npm: "fails", answer: failing, expected: "99.0.0" },
  ])("when npm $npm, the Claude Code version stays at a version Tau already had", (fixture) =>
    run(
      Effect.gen(function* () {
        const server = yield* fakeServer({ "/api.json": failing, "/claude-code": fixture.answer });
        const setup = { serverUrl: server.url, cache: oldCache("99.0.0"), credentials: [] };

        const version = yield* withCatalog(setup, (catalog) =>
          catalog.refreshIfStale.pipe(Effect.andThen(catalog.claudeCodeVersion)),
        );

        expect(version).toBe(fixture.expected);
      }),
    ),
  );

  test("the Codex plan list hides unlisted models and replaces the API context limit", () =>
    run(
      Effect.gen(function* () {
        const server = yield* fakeServer({
          "/api.json": failing,
          "/claude-code": failing,
          "/backend-api/codex/models": json({
            models: [
              { slug: "gpt-6-luna", context_window: CODEX_CONTEXT_TOKENS, visibility: "list" },
              { slug: "gpt-6-sol", context_window: CODEX_CONTEXT_TOKENS, visibility: "hide" },
            ],
          }),
        });

        const setup = {
          serverUrl: server.url,
          cache: undefined,
          credentials: [["codex", codexLogin] as const],
        };

        const [luna, sol] = yield* withCatalog(setup, (catalog) =>
          catalog.refreshIfStale.pipe(
            Effect.andThen(
              Effect.all([
                catalog.model(codexRef("gpt-6-luna")),
                Effect.exit(catalog.model(codexRef("gpt-6-sol"))),
              ]),
            ),
          ),
        );

        expect(luna.profile.contextTokens).toBe(CODEX_CONTEXT_TOKENS);
        expect(Exit.isFailure(sol)).toBe(true);
        // ChatGPT has a plan list too, but without a login there is nothing to ask for.
        expect(server.received).not.toContain("/v1/models");
      }),
    ));

  test.each([
    {
      problem: "a protocol Tau does not speak",
      providers: { local: { protocol: "grpc", apiUrl: "http://localhost:1/v1" } },
      message: "has a wrong value",
    },
    {
      problem: "a new address for a built-in provider",
      providers: { openai: { apiUrl: "http://localhost:1/v1" } },
      message: "providers.openai, a built-in provider",
    },
    {
      problem: "a new provider with no address",
      providers: { local: { protocol: "openaiChat" } },
      message: "has no protocol or apiUrl for providers.local",
    },
  ])("settings with $problem fail, naming the file and the provider", (fixture) =>
    run(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const tauDirectory = yield* fileSystem.makeTempDirectoryScoped();
        const settingsPath = `${tauDirectory}/settings.json`;
        const settings = { providers: fixture.providers };
        const settingsText = Schema.encodeSync(Schema.fromJsonString(Schema.Json))(settings);
        yield* fileSystem.writeFileString(settingsPath, settingsText);

        const exit = yield* Effect.exit(
          Layer.build(Settings.layer.pipe(Layer.provide(TauHome.at(tauDirectory)))),
        );

        expect(Exit.isFailure(exit) && String(exit.cause)).toContain(settingsPath);
        expect(Exit.isFailure(exit) && String(exit.cause)).toContain(fixture.message);
      }),
    ),
  );
});
