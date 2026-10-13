import { describe, expect, test } from "bun:test";
import { BunCrypto } from "@effect/platform-bun";
import { DateTime, Effect, Exit, FileSystem, Layer, Option, Redacted, Schema } from "effect";
import { ChatgptAppTokens, type CredentialStore, ProviderId } from "../../src/ai/Credential.ts";
import { HostId, logIn as logInRoute, logOut } from "../../src/ai/Login.ts";
import type { ChatgptApp, Route } from "../../src/ai/Routes.ts";
import { TauHome } from "../../src/database/TauHome.ts";
import { hostIdLayer } from "../../src/host/HostId.ts";
import {
  neverPastes,
  routeNamed,
  run,
  sha256,
  signedAuthorization,
  TEST_HOST_ID,
  withCredentials,
} from "../support/login-harness.ts";

const PROVIDER = ProviderId.make("chatgpt");
const RESOURCE = "https://api.test/v1";
const PLAN_SCOPE = "chatgpt.tokens.use.direct";
const ISSUED_CLIENT_ID = "oaiapp_test";

const rsa = {
  name: "RSASSA-PKCS1-v1_5",
  modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]),
  hash: "SHA-256",
};

const publishedKey = await crypto.subtle.generateKey(rsa, true, ["sign", "verify"]);
const unpublishedKey = await crypto.subtle.generateKey(rsa, true, ["sign", "verify"]);

const publishedJwk = {
  ...(await crypto.subtle.exportKey("jwk", publishedKey.publicKey)),
  kid: "test-key",
};

const base64url = (value: string | Uint8Array) => Buffer.from(value).toString("base64url");

const signIdToken = async (claims: Record<string, unknown>, key: CryptoKey) => {
  const signed = `${base64url(JSON.stringify({ alg: "RS256", kid: "test-key" }))}.${base64url(JSON.stringify(claims))}`;
  const signature = await crypto.subtle.sign(rsa.name, key, new TextEncoder().encode(signed));
  return `${signed}.${base64url(new Uint8Array(signature))}`;
};

type FakeOptions = {
  readonly nonce: "match" | "wrong";
  readonly signingKey: "published" | "unpublished";
  readonly grantsPlan: boolean;
};

const honest: FakeOptions = { nonce: "match", signingKey: "published", grantsPlan: true };

/**
 * OpenAI's Sign in with ChatGPT endpoints: registers on `dynamic_agent_client`, checks PKCE, client
 * ID and resource, signs ID tokens, rotates refresh tokens, and records what each endpoint received.
 */
const fakeOpenAi = (options: FakeOptions) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const codes = new Map<string, { challenge: string; clientId: string; nonce: string }>();

      const recorded = {
        url: "",
        authorize: [] as Record<string, string>[],
        token: [] as Record<string, string>[],
        revoke: [] as Record<string, string>[],
        validRefresh: "refresh-0",
        issued: 0,
      };

      const issue = async (clientId: string, nonce: string | undefined) => {
        recorded.issued += 1;
        recorded.validRefresh = `refresh-${recorded.issued}`;
        const claimedNonce = options.nonce === "match" ? nonce : "another-login";

        const idToken = await signIdToken(
          {
            iss: recorded.url,
            aud: [clientId],
            exp: Math.floor(Date.now() / 1000) + 3600,
            sub: "user-1",
            ...(nonce === undefined ? {} : { nonce: claimedNonce }),
          },
          options.signingKey === "published" ? publishedKey.privateKey : unpublishedKey.privateKey,
        );

        return Response.json({
          access_token: `access-${recorded.issued}`,
          refresh_token: recorded.validRefresh,
          id_token: idToken,
          expires_in: 3600,
          scope: `openid profile email offline_access resource.invoke${options.grantsPlan ? ` ${PLAN_SCOPE}` : ""}`,
        });
      };

      const token = (fields: Record<string, string>) => {
        if (fields.resource !== RESOURCE)
          return Response.json({ error: "invalid_target" }, { status: 400 });

        if (fields.grant_type === "refresh_token") {
          const isValid =
            fields.refresh_token === recorded.validRefresh && fields.client_id === ISSUED_CLIENT_ID;

          return isValid
            ? issue(ISSUED_CLIENT_ID, undefined)
            : Response.json({ error: "invalid_grant" }, { status: 400 });
        }

        const pending = codes.get(fields.code ?? "");

        const isValid =
          pending !== undefined &&
          pending.clientId === fields.client_id &&
          pending.challenge === sha256(fields.code_verifier ?? "");

        if (!isValid) return Response.json({ error: "invalid_grant" }, { status: 400 });
        codes.delete(fields.code ?? "");
        return issue(pending.clientId, pending.nonce);
      };

      const server = Bun.serve({
        port: 0,
        fetch: async (request) => {
          const url = new URL(request.url);

          if (url.pathname === "/authorize") {
            const params = Object.fromEntries(url.searchParams);
            recorded.authorize.push(params);
            const isRegistration = params.client_id === "dynamic_agent_client";
            const clientId = isRegistration ? ISSUED_CLIENT_ID : (params.client_id ?? "");
            const code = `code-${recorded.authorize.length}`;

            codes.set(code, {
              challenge: params.code_challenge ?? "",
              clientId,
              nonce: params.nonce ?? "",
            });

            const redirect = new URL(params.redirect_uri ?? "");

            redirect.search = new URLSearchParams({
              code,
              state: params.state ?? "",
              ...(isRegistration ? { client_id: clientId } : {}),
            }).toString();

            return Response.redirect(redirect.toString(), 302);
          }

          if (url.pathname === "/jwks") return Response.json({ keys: [publishedJwk] });
          const fields = Object.fromEntries(new URLSearchParams(await request.text()));

          if (url.pathname === "/token") {
            recorded.token.push(fields);
            return token(fields);
          }

          if (url.pathname === "/revoke") {
            recorded.revoke.push(fields);
            return new Response(null, { status: 200 });
          }

          return new Response("Not found", { status: 404 });
        },
      });

      recorded.url = `http://localhost:${server.port}`;
      return { recorded, server };
    }),
    ({ server }) => Effect.promise(() => server.stop(true)),
  ).pipe(Effect.map(({ recorded }) => recorded));

const fakeApp = (url: string): ChatgptApp => ({
  authorizeUrl: `${url}/authorize`,
  tokenUrl: `${url}/token`,
  revokeUrl: `${url}/revoke`,
  jwksUrl: `${url}/jwks`,
  issuer: url,
  resource: RESOURCE,
  scopes: `openid profile email offline_access resource.invoke ${PLAN_SCOPE}`,
  agentName: "Tau",
  callback: { host: "127.0.0.1", port: 0, path: "/auth/callback" },
});

const fakeRoute = (url: string): Route => ({
  ...routeNamed("chatgpt"),
  auth: { kind: "chatgptApp", app: fakeApp(url) },
});

const savedLogin = (store: CredentialStore["Service"]) =>
  store.read(PROVIDER).pipe(Effect.map(Option.filter(Schema.is(ChatgptAppTokens))));

const logIn = (url: string) => logInRoute(fakeRoute(url));

describe("Sign in with ChatGPT", () => {
  test("a first login registers Tau and saves the issued app ID", () =>
    run(
      Effect.gen(function* () {
        const openAi = yield* fakeOpenAi(honest);

        const saved = yield* withCredentials(neverPastes, (store) =>
          logIn(openAi.url).pipe(Effect.andThen(savedLogin(store))),
        );

        expect(openAi.authorize[0]).toMatchObject({
          client_id: "dynamic_agent_client",
          agent_name_hint: "Tau",
          ext_agent_host_id: TEST_HOST_ID,
          resource: RESOURCE,
        });

        expect(Option.map(saved, (tokens) => tokens.clientId)).toEqual(
          Option.some(ISSUED_CLIENT_ID),
        );
      }),
    ));

  test("a later login reuses the registration and hints the account", () =>
    run(
      Effect.gen(function* () {
        const openAi = yield* fakeOpenAi(honest);

        yield* withCredentials(neverPastes, () =>
          logIn(openAi.url).pipe(Effect.andThen(logIn(openAi.url))),
        );

        const second = openAi.authorize[1];

        expect(second).toMatchObject({
          client_id: ISSUED_CLIENT_ID,
          ext_agent_host_id: TEST_HOST_ID,
        });

        expect(second?.id_token_hint).toBeString();
        expect(second?.agent_name_hint).toBeUndefined();
      }),
    ));

  test.each([
    {
      name: "a nonce from another login",
      options: { ...honest, nonce: "wrong" },
      message: "belongs to another login",
    },
    {
      name: "an unpublished signing key",
      options: { ...honest, signingKey: "unpublished" },
      message: "signature does not match",
    },
    {
      name: "no plan permission",
      options: { ...honest, grantsPlan: false },
      message: "did not allow Tau to use your ChatGPT plan",
    },
  ] satisfies ReadonlyArray<{ name: string; options: FakeOptions; message: string }>)(
    "a login with $name fails and saves nothing",
    ({ options, message }) =>
      run(
        Effect.gen(function* () {
          const openAi = yield* fakeOpenAi(options);

          const [exit, saved] = yield* withCredentials(neverPastes, (store) =>
            Effect.all([Effect.exit(logIn(openAi.url)), savedLogin(store)]),
          );

          expect(Exit.isFailure(exit) && String(exit.cause)).toContain(message);
          expect(Option.isNone(saved)).toBe(true);
        }),
      ),
  );

  test("a refresh sends the issued app ID and resource", () =>
    run(
      Effect.gen(function* () {
        const openAi = yield* fakeOpenAi(honest);

        const expired = ChatgptAppTokens.make({
          clientId: ISSUED_CLIENT_ID,
          idToken: Redacted.make("previous-id-token"),
          access: Redacted.make("expired-access"),
          refresh: Redacted.make(openAi.validRefresh),
          expiresAt: DateTime.makeUnsafe(Date.now()),
        });

        const authorization = yield* withCredentials(neverPastes, (store) =>
          store
            .save(PROVIDER, expired)
            .pipe(Effect.andThen(signedAuthorization(fakeRoute(openAi.url)))),
        );

        expect(authorization).toBe("Bearer access-1");

        expect(openAi.token[0]).toMatchObject({
          grant_type: "refresh_token",
          client_id: ISSUED_CLIENT_ID,
          resource: RESOURCE,
        });
      }),
    ));

  test("logging out revokes the refresh token", () =>
    run(
      Effect.gen(function* () {
        const openAi = yield* fakeOpenAi(honest);

        yield* withCredentials(neverPastes, (store) =>
          logIn(openAi.url).pipe(
            Effect.andThen(logOut(fakeRoute(openAi.url))),
            Effect.andThen(savedLogin(store)),
            Effect.map((saved) => expect(Option.isNone(saved)).toBe(true)),
          ),
        );

        expect(openAi.revoke[0]).toEqual({
          token: "refresh-1",
          token_type_hint: "refresh_token",
          client_id: ISSUED_CLIENT_ID,
        });
      }),
    ));
});

test("the host ID is created once and kept", () =>
  run(
    Effect.gen(function* () {
      const tauDirectory = `${yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped()}/.tau`;
      const hostIdAt = hostIdLayer.pipe(Layer.provide(TauHome.at(tauDirectory)));
      const first = yield* HostId.use((hostId) => hostId.read).pipe(Effect.provide(hostIdAt));
      const second = yield* HostId.use((hostId) => hostId.read).pipe(Effect.provide(hostIdAt));

      expect(first).toMatch(/^urn:uuid:[0-9a-f-]{36}$/);
      expect(second).toBe(first);
    }).pipe(Effect.provide(BunCrypto.layer)),
  ));
