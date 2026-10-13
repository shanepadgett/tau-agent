import { describe, expect, test } from "bun:test";
import { DateTime, Effect, Exit, Option, Predicate, Redacted } from "effect";
import { ApiKey, type CredentialStore, OAuthTokens, ProviderId } from "../src/ai/credential.ts";
import { type LoginMethod, logIn } from "../src/ai/login.ts";
import type { OAuthClient, Route } from "../src/ai/routes.ts";
import {
  type Browser,
  neverPastes,
  routeNamed,
  run,
  sha256,
  signedAuthorization,
  withCredentials,
} from "./support/login-harness.ts";

const DEVICE_CODE = { code: "device-code", verifier: "device-verifier" };

/**
 * An OAuth server that redirects every authorize request with a new code, checks the PKCE pair,
 * rotates refresh tokens and refuses a stale one, and answers the device code after two polls.
 */
const fakeAuthServer = Effect.acquireRelease(
  Effect.sync(() => {
    const challenges = new Map([[DEVICE_CODE.code, sha256(DEVICE_CODE.verifier)]]);
    const auth = { url: "", refreshes: 0, devicePolls: 0, validRefresh: "refresh-0", issued: 0 };

    const issueTokens = () => {
      auth.issued += 1;
      auth.validRefresh = `refresh-${auth.issued}`;

      return Response.json({
        access_token: `access-${auth.issued}`,
        refresh_token: auth.validRefresh,
        expires_in: 3600,
      });
    };

    const token = (fields: Record<string, string>) => {
      if (fields.grant_type === "refresh_token") {
        if (fields.refresh_token !== auth.validRefresh)
          return Response.json({ error: "invalid_grant" }, { status: 400 });

        auth.refreshes += 1;
        return issueTokens();
      }

      const challenge = challenges.get(fields.code ?? "");

      if (challenge === undefined || challenge !== sha256(fields.code_verifier ?? ""))
        return Response.json({ error: "invalid_grant" }, { status: 400 });

      challenges.delete(fields.code ?? "");
      return issueTokens();
    };

    const devicePoll = () => {
      auth.devicePolls += 1;
      if (auth.devicePolls === 1) return new Response(null, { status: 403 });

      if (auth.devicePolls === 2)
        return Response.json(
          { error: { code: "deviceauth_authorization_pending" } },
          { status: 400 },
        );

      return Response.json({
        authorization_code: DEVICE_CODE.code,
        code_verifier: DEVICE_CODE.verifier,
      });
    };

    const server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        const url = new URL(request.url);

        if (url.pathname === "/authorize") {
          const code = `code-${challenges.size}`;
          challenges.set(code, url.searchParams.get("code_challenge") ?? "");
          const redirect = new URL(url.searchParams.get("redirect_uri") ?? "");

          redirect.search = new URLSearchParams({
            code,
            state: url.searchParams.get("state") ?? "",
          }).toString();

          return Response.redirect(redirect.toString(), 302);
        }

        if (url.pathname === "/token") {
          const isJson = request.headers.get("content-type")?.includes("json") === true;
          const body = await request.text();
          return token(isJson ? JSON.parse(body) : Object.fromEntries(new URLSearchParams(body)));
        }

        if (url.pathname === "/device/usercode")
          return Response.json({
            device_auth_id: "device-1",
            user_code: "ABCD-1234",
            interval: "0",
          });

        if (url.pathname === "/device/token") return devicePoll();
        return new Response("Not found", { status: 404 });
      },
    });

    auth.url = `http://localhost:${server.port}`;
    return { auth, server };
  }),
  ({ server }) => Effect.promise(() => server.stop(true)),
).pipe(Effect.map(({ auth }) => auth));

/** The built-in route's OAuth client, pointed at the fake server and a free callback port. */
const fakeOAuth = (id: string, authUrl: string): OAuthClient => {
  const route = routeNamed(id);

  if (
    route.auth.kind === "none" ||
    route.auth.kind === "apiKey" ||
    route.auth.kind === "chatgptApp"
  )
    throw new Error(`${id} has no OAuth client`);

  const { oauth } = route.auth;

  return {
    ...oauth,
    authorizeUrl: `${authUrl}/authorize`,
    tokenUrl: `${authUrl}/token`,
    callback: { ...oauth.callback, port: 0 },
    headless:
      oauth.headless.kind === "copyCode"
        ? { kind: "copyCode", redirectUri: `${authUrl}/code/callback` }
        : {
            kind: "deviceCode",
            userCodeUrl: `${authUrl}/device/usercode`,
            pollUrl: `${authUrl}/device/token`,
            verificationUrl: `${authUrl}/device`,
            redirectUri: `${authUrl}/device/callback`,
          },
  };
};

const fakeRoute = (id: string, authUrl: string): Route => {
  const route = routeNamed(id);
  const hasOAuth = route.auth.kind === "claudeSubscription" || route.auth.kind === "codexLogin";
  if (!hasOAuth) return route;
  return { ...route, auth: { ...route.auth, oauth: fakeOAuth(id, authUrl) } };
};

const storedAccess = (store: CredentialStore["Service"], provider: string) =>
  store
    .read(ProviderId.make(provider))
    .pipe(
      Effect.map((stored) =>
        Option.isSome(stored) && Predicate.isTagged(stored.value, "OAuthTokens")
          ? Redacted.value(stored.value.access)
          : undefined,
      ),
    );

const expiredTokens = (refresh: string) =>
  OAuthTokens.make({
    access: Redacted.make("expired-access"),
    refresh: Redacted.make(refresh),
    expiresAt: DateTime.makeUnsafe(Date.now()),
  });

const loginCases: ReadonlyArray<{
  readonly name: string;
  readonly route: string;
  readonly method: LoginMethod;
  readonly browser: Browser;
}> = [
  {
    name: "Claude through the callback",
    route: "anthropic",
    method: "browser",
    browser: neverPastes,
  },
  {
    name: "ChatGPT through a pasted address",
    route: "codex",
    method: "browser",
    browser: { reachesCallback: false, paste: (redirect) => redirect.toString() },
  },
  {
    name: "Claude through the copy-code page",
    route: "anthropic",
    method: "headless",
    browser: {
      reachesCallback: false,
      paste: (redirect) =>
        `${redirect.searchParams.get("code")}#${redirect.searchParams.get("state")}`,
    },
  },
  {
    name: "ChatGPT through a device code",
    route: "codex",
    method: "headless",
    browser: neverPastes,
  },
];

describe("login", () => {
  test.each(loginCases)("$name saves tokens", ({ route, method, browser }) =>
    run(
      Effect.gen(function* () {
        const auth = yield* fakeAuthServer;

        const access = yield* withCredentials(browser, (store) =>
          logIn(ProviderId.make(route), fakeOAuth(route, auth.url), method).pipe(
            Effect.andThen(storedAccess(store, route)),
          ),
        );

        // The fake server issues tokens only when the verifier matches the challenge.
        expect(access).toBe("access-1");
      }),
    ),
  );

  test("the device code login waits through pending answers", () =>
    run(
      Effect.gen(function* () {
        const auth = yield* fakeAuthServer;

        yield* withCredentials(neverPastes, () =>
          logIn(ProviderId.make("codex"), fakeOAuth("codex", auth.url), "headless"),
        );

        expect(auth.devicePolls).toBe(3);
      }),
    ));

  test("a pasted address from another login fails and saves nothing", () =>
    run(
      Effect.gen(function* () {
        const auth = yield* fakeAuthServer;

        const browser: Browser = {
          reachesCallback: false,
          paste: (redirect) => {
            redirect.searchParams.set("state", "another-login");
            return redirect.toString();
          },
        };

        const [exit, access] = yield* withCredentials(browser, (store) =>
          Effect.all([
            Effect.exit(
              logIn(ProviderId.make("anthropic"), fakeOAuth("anthropic", auth.url), "browser"),
            ),
            storedAccess(store, "anthropic"),
          ]),
        );

        expect(Exit.isFailure(exit) && String(exit.cause)).toContain(
          "belongs to a different login",
        );

        expect(access).toBeUndefined();
      }),
    ));
});

describe("token refresh", () => {
  test("an expired login refreshes once for concurrent requests, which carry the new token", () =>
    run(
      Effect.gen(function* () {
        const auth = yield* fakeAuthServer;
        const route = fakeRoute("anthropic", auth.url);

        const [authorizations, access] = yield* withCredentials(neverPastes, (store) =>
          store.save(route.provider, expiredTokens(auth.validRefresh)).pipe(
            Effect.andThen(
              Effect.all(
                [
                  signedAuthorization(route),
                  signedAuthorization(route),
                  signedAuthorization(route),
                ],
                {
                  concurrency: "unbounded",
                },
              ),
            ),
            Effect.flatMap((signed) =>
              Effect.all([Effect.succeed(signed), storedAccess(store, "anthropic")]),
            ),
          ),
        );

        expect(authorizations).toEqual(["Bearer access-1", "Bearer access-1", "Bearer access-1"]);
        expect(access).toBe("access-1");
        expect(auth.refreshes).toBe(1);
      }),
    ));

  test("a refused refresh asks the user to log in again", () =>
    run(
      Effect.gen(function* () {
        const auth = yield* fakeAuthServer;
        const route = fakeRoute("codex", auth.url);

        const exit = yield* withCredentials(neverPastes, (store) =>
          store
            .save(route.provider, expiredTokens("revoked"))
            .pipe(Effect.andThen(Effect.exit(signedAuthorization(route)))),
        );

        expect(Exit.isFailure(exit) && String(exit.cause)).toContain(
          "codex login has expired. Run tau login.",
        );
      }),
    ));
});

test("a saved API key wins over the environment variable", () =>
  run(
    Effect.gen(function* () {
      const route = routeNamed("openrouter");

      const authorization = yield* withCredentials(neverPastes, (store) =>
        store
          .save(route.provider, ApiKey.make({ key: Redacted.make("saved-key") }))
          .pipe(Effect.andThen(signedAuthorization(route))),
      );

      expect(authorization).toBe("Bearer saved-key");
    }),
  ));
