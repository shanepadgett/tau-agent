/**
 * Logs in with Sign in with ChatGPT, where Tau is registered as its own app. Checks the ID token,
 * and revokes the login when the user logs out.
 */

import { Clock, Crypto, Effect, Option, Redacted, Result, Schema } from "effect";
import { Base64Url } from "effect/encoding";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { ChatgptAppTokens, CredentialStore, type ProviderId } from "./credential.ts";
import { asLoginFailed, type AuthorizedCode, authorizeInBrowser, LoginFailed } from "./login.ts";
import type { ChatgptApp } from "./routes.ts";
import { chatgptAppTokenEndpoint, requestTokens } from "./token-endpoint.ts";

/** The scope that lets requests spend the user's plan; a login can succeed without it. */
const PLAN_SCOPE = "chatgpt.tokens.use.direct";

/** The client ID a first login registers with; OpenAI then issues Tau's own. */
const REGISTRATION_CLIENT_ID = "dynamic_agent_client";

const NONCE_BYTES = 32;
const MILLIS_PER_SECOND = 1000;
const SIGNATURE_ALGORITHM = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };

const fromBase64UrlJson = <S extends Schema.Top>(schema: S) =>
  Schema.StringFromBase64Url.pipe(Schema.decodeTo(Schema.fromJsonString(schema)));

const IdTokenHeader = fromBase64UrlJson(
  Schema.Struct({ alg: Schema.Literal("RS256"), kid: Schema.String }),
);

const IdTokenClaims = fromBase64UrlJson(
  Schema.Struct({
    iss: Schema.String,
    aud: Schema.Union([Schema.String, Schema.Array(Schema.String)]),
    exp: Schema.Number,
    nonce: Schema.optional(Schema.String),
  }),
);

/** An RSA public key as JWKS publishes it, where the modulus and exponent are `n` and `e`. */
const RsaKey = Schema.Struct({
  kid: Schema.String,
  kty: Schema.Literal("RSA"),
  modulus: Schema.String,
  exponent: Schema.String,
}).pipe(Schema.encodeKeys({ modulus: "n", exponent: "e" }));

const SigningKeys = Schema.Struct({ keys: Schema.Array(RsaKey) });

/** What this login attempt sent, which the reply and its ID token must match. */
type LoginAttempt = {
  readonly provider: ProviderId;
  readonly app: ChatgptApp;
  readonly saved: Option.Option<ChatgptAppTokens>;
  readonly nonce: string;
};

/**
 * Logs in with the registration saved for `provider`, or registers Tau on the first login, and saves
 * the tokens. `hostId` names this machine to OpenAI and stays the same across logins.
 */
export const logInChatgptApp = Effect.fn("logInChatgptApp")(
  function* (provider: ProviderId, app: ChatgptApp, hostId: string) {
    const store = yield* CredentialStore;
    const saved = Option.filter(yield* store.read(provider), Schema.is(ChatgptAppTokens));
    const nonce = Base64Url.encode(yield* (yield* Crypto.Crypto).randomBytes(NONCE_BYTES));

    const registration = Option.match(saved, {
      onNone: () => ({ client_id: REGISTRATION_CLIENT_ID, agent_name_hint: app.agentName }),
      onSome: (tokens) => ({
        client_id: tokens.clientId,
        id_token_hint: Redacted.value(tokens.idToken),
      }),
    });

    const params = {
      ...registration,
      ext_agent_host_id: hostId,
      scope: app.scopes,
      resource: app.resource,
      nonce,
    };

    const attempt: LoginAttempt = { provider, app, saved, nonce };

    const tokens = yield* authorizeInBrowser(
      provider,
      { authorizeUrl: app.authorizeUrl, params, callback: app.callback },
      (authorized) => exchangeCode(attempt, authorized),
    );

    yield* store.save(provider, tokens);
  },
  (effect, provider) => asLoginFailed(effect, provider),
);

/** Ends the login on OpenAI's side, so the refresh token stops working everywhere. */
export const revokeChatgptApp = Effect.fn("revokeChatgptApp")(function* (
  app: ChatgptApp,
  tokens: ChatgptAppTokens,
) {
  const client = yield* HttpClient.HttpClient;

  const request = HttpClientRequest.bodyUrlParams(HttpClientRequest.post(app.revokeUrl), {
    token: Redacted.value(tokens.refresh),
    token_type_hint: "refresh_token",
    client_id: tokens.clientId,
  });

  yield* client.execute(request).pipe(Effect.flatMap(HttpClientResponse.filterStatusOk));
});

/** Exchanges the code, then accepts the tokens only with plan permission and a valid ID token. */
const exchangeCode = Effect.fn("exchangeCode")(function* (
  attempt: LoginAttempt,
  authorized: AuthorizedCode,
) {
  const { provider, app } = attempt;
  const clientId = yield* issuedClientId(provider, attempt.saved, authorized.clientId);

  const issued = yield* requestTokens(provider, chatgptAppTokenEndpoint(app, clientId), {
    grant_type: "authorization_code",
    code: authorized.code,
    code_verifier: authorized.verifier,
    redirect_uri: authorized.redirectUri,
    state: undefined,
  });

  if (!issued.scopes.includes(PLAN_SCOPE)) return yield* planNotAllowed(provider);
  if (issued.idToken === undefined) return yield* invalidIdToken(provider, "none was issued");
  yield* verifyIdToken(attempt, clientId, issued.idToken);

  return ChatgptAppTokens.make({
    clientId,
    idToken: Redacted.make(issued.idToken),
    access: issued.tokens.access,
    refresh: issued.tokens.refresh,
    expiresAt: issued.tokens.expiresAt,
  });
});

/**
 * A first login must come back with Tau's new app ID. A later login keeps its registration, so a
 * different ID means the reply belongs to another registration.
 */
const issuedClientId = (
  provider: ProviderId,
  saved: Option.Option<ChatgptAppTokens>,
  returned: string | undefined,
) => {
  if (Option.isSome(saved)) {
    const isOtherRegistration = returned !== undefined && returned !== saved.value.clientId;
    if (!isOtherRegistration) return Effect.succeed(saved.value.clientId);
    return registrationFailed(provider, "the reply names a different app than the saved login");
  }

  if (returned === undefined) return registrationFailed(provider, "OpenAI did not issue an app ID");
  return Effect.succeed(returned);
};

/** Checks the ID token's signature against OpenAI's published keys, then its issuer, audience, expiry and nonce. */
const verifyIdToken = Effect.fn("verifyIdToken")(function* (
  attempt: LoginAttempt,
  clientId: string,
  idToken: string,
) {
  const { provider, app } = attempt;
  const [encodedHeader = "", encodedClaims = "", encodedSignature = ""] = idToken.split(".");
  const header = yield* Schema.decodeUnknownEffect(IdTokenHeader)(encodedHeader);
  const claims = yield* Schema.decodeUnknownEffect(IdTokenClaims)(encodedClaims);
  const signature = Base64Url.decode(encodedSignature);

  if (Result.isFailure(signature))
    return yield* invalidIdToken(provider, "its signature is unreadable");

  const keys = yield* (yield* HttpClient.HttpClient)
    .get(app.jwksUrl)
    .pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(HttpClientResponse.schemaBodyJson(SigningKeys)),
    );

  const key = keys.keys.find((candidate) => candidate.kid === header.kid);
  if (key === undefined) return yield* invalidIdToken(provider, "no published key signed it");

  const signed = new TextEncoder().encode(`${encodedHeader}.${encodedClaims}`);
  const isSigned = yield* verifySignature(provider, key, signed, signature.success);

  if (!isSigned) return yield* invalidIdToken(provider, "its signature does not match");

  if (claims.iss !== app.issuer)
    return yield* invalidIdToken(provider, `it was issued by ${claims.iss}`);

  const audience = Schema.is(Schema.String)(claims.aud) ? [claims.aud] : claims.aud;
  if (!audience.includes(clientId)) return yield* invalidIdToken(provider, "it is for another app");

  const isExpired = claims.exp * MILLIS_PER_SECOND <= (yield* Clock.currentTimeMillis);
  if (isExpired) return yield* invalidIdToken(provider, "it has expired");

  if (claims.nonce !== attempt.nonce)
    return yield* invalidIdToken(provider, "it belongs to another login");
});

const verifySignature = Effect.fn("verifySignature")(function* (
  provider: ProviderId,
  key: typeof RsaKey.Type,
  signed: Uint8Array<ArrayBuffer>,
  signature: Uint8Array,
) {
  const unusableKey = (cause: unknown) =>
    new LoginFailed({
      provider,
      reason: "invalidIdToken",
      message: `${provider} published a signing key Tau cannot use. Run tau login to try again.`,
      cause,
    });

  const jwk = Schema.encodeSync(RsaKey)(key);

  const publicKey = yield* Effect.tryPromise({
    try: () => crypto.subtle.importKey("jwk", jwk, SIGNATURE_ALGORITHM, false, ["verify"]),
    catch: unusableKey,
  });

  return yield* Effect.tryPromise({
    try: () =>
      crypto.subtle.verify(SIGNATURE_ALGORITHM, publicKey, new Uint8Array(signature), signed),
    catch: unusableKey,
  });
});

const registrationFailed = (provider: ProviderId, why: string) =>
  Effect.fail(
    new LoginFailed({
      provider,
      reason: "registrationFailed",
      message: `Registering Tau with ${provider} failed: ${why}. Run tau login to try again.`,
    }),
  );

const invalidIdToken = (provider: ProviderId, why: string) =>
  Effect.fail(
    new LoginFailed({
      provider,
      reason: "invalidIdToken",
      message: `${provider} sent an ID token Tau cannot trust: ${why}. Run tau login to try again.`,
    }),
  );

const planNotAllowed = (provider: ProviderId) =>
  Effect.fail(
    new LoginFailed({
      provider,
      reason: "planNotAllowed",
      message: `${provider} login did not allow Tau to use your ChatGPT plan. Run tau login and allow plan use, or use an OpenAI API key.`,
    }),
  );
