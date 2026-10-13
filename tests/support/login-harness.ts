import { BunCrypto, BunFileSystem } from "@effect/platform-bun";
import { ConfigProvider, Context, Effect, FileSystem, Layer, type Scope } from "effect";
import { FetchHttpClient, HttpClientRequest } from "effect/http";
import { CredentialStore } from "../../src/ai/Credential.ts";
import { HostId, type LoginMethod, LoginPrompt } from "../../src/ai/Login.ts";
import { credentialSigner } from "../../src/ai/internal/signing/route-auth.ts";
import { builtInRoutes, type Route, RouteId } from "../../src/ai/Routes.ts";
import { TauHome } from "../../src/database/TauHome.ts";
import { credentialStoreLayer } from "../../src/host/CredentialStore.ts";

export const sha256 = (text: string) =>
  new Bun.CryptoHasher("sha256").update(text).digest("base64url");

export const routeNamed = (id: string) => {
  const route = builtInRoutes.find((candidate) => candidate.id === RouteId.make(id));
  if (route === undefined) throw new Error(`No built-in route ${id}`);
  return route;
};

export type Browser = {
  /** How the user chooses to log in, when Tau asks. */
  readonly method: LoginMethod;
  /** Whether the browser reaches Tau's callback after logging in. */
  readonly reachesCallback: boolean;
  /** What the user pastes, given where the browser ended up; undefined never answers. */
  readonly paste: (redirect: URL) => string | undefined;
};

/** Plays the user: logs in at the authorize URL Tau shows, then follows or pastes the redirect. */
const fakeUser = (browser: Browser) => {
  let redirect = new URL("http://nowhere.invalid");

  const visit = (url: string) =>
    Effect.promise(async () => {
      const response = await fetch(url, { redirect: "manual" });
      redirect = new URL(response.headers.get("location") ?? "");
      if (browser.reachesCallback) await fetch(redirect);
    });

  return Layer.succeed(
    LoginPrompt,
    LoginPrompt.of({
      openBrowser: visit,
      show: (text) => {
        const authorizeUrl = /http\S+\/authorize\?\S+/.exec(text)?.[0];
        return authorizeUrl === undefined ? Effect.void : visit(authorizeUrl);
      },
      ask: () =>
        Effect.suspend(() => {
          const answer = browser.paste(redirect);
          return answer === undefined ? Effect.never : Effect.succeed(answer);
        }),
      askSecret: () => Effect.die("No test types an API key."),
      chooseMethod: () => Effect.succeed(browser.method),
    }),
  );
};

export const neverPastes: Browser = {
  method: "browser",
  reachesCallback: true,
  paste: () => undefined,
};

/** The host ID that tests send to the fake Sign in with ChatGPT server. */
export const TEST_HOST_ID = "urn:uuid:00000000-0000-4000-8000-000000000000";

const environment = { OPENROUTER_API_KEY: "environment-key" };

export const withCredentials = <A, E, R>(
  browser: Browser,
  program: (store: CredentialStore["Service"]) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const tauDirectory = `${yield* fileSystem.makeTempDirectoryScoped()}/.tau`;

    const layer = Layer.mergeAll(
      credentialStoreLayer.pipe(Layer.provide(TauHome.at(tauDirectory))),
      Layer.succeed(HostId, { read: Effect.succeed(TEST_HOST_ID) }),
      FetchHttpClient.layer,
      BunCrypto.layer,
      fakeUser(browser),
      ConfigProvider.layer(ConfigProvider.fromUnknown(environment)),
    );

    const context = yield* Layer.build(layer);

    return yield* program(Context.get(context, CredentialStore)).pipe(
      Effect.provideContext(context),
    );
  });

export const run = <A, E>(program: Effect.Effect<A, E, Scope.Scope | FileSystem.FileSystem>) =>
  Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(BunFileSystem.layer)));

export const signedAuthorization = (route: Route) =>
  credentialSigner(route, {
    protocol: route.protocol,
    claudeCodeVersion: "2.1.296",
    conversationId: undefined,
  }).pipe(
    Effect.map((sign) => sign(HttpClientRequest.get("https://example.com")).headers.authorization),
  );
