/** Logs in to a subscription with OAuth and returns its tokens. It works with a browser on this machine, or with a code when there is no browser. */

import {
  Crypto,
  Deferred,
  Duration,
  Effect,
  Exit,
  Option,
  Predicate,
  Schema,
  type Scope,
} from "effect";
import { Base64Url } from "effect/encoding";
import {
  HttpClient,
  type HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/http";
import type { ProviderId } from "../../Providers.ts";
import type { HeadlessLogin, LoginCallback, OAuthClient } from "../../Providers.ts";
import { LoginFailed, type LoginMethod, LoginPrompt } from "./login-services.ts";
import { oauthTokenEndpoint, requestTokens, type TokenRequestFailed } from "./token-endpoint.ts";

class CallbackUnavailable extends Schema.TaggedError<CallbackUnavailable>()("CallbackUnavailable", {
  port: Schema.Number,
  cause: Schema.Defect(),
}) {}

/** RFC 8628: each `slow_down` answer adds five seconds to the polling interval. */
const SLOW_DOWN_STEP = Duration.fromInputUnsafe("5 seconds");

const DEVICE_CODE_LIFETIME = Duration.fromInputUnsafe("15 minutes");

const HTTP_OK = 200;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;

/** OpenAI answers these while the user has not yet entered the device code. */
const DEVICE_PENDING_STATUSES = [HTTP_FORBIDDEN, HTTP_NOT_FOUND];

const VERIFIER_BYTES = 32;

/** Claude's authorize page rejects a shorter state as "Invalid request format". */
const STATE_BYTES = 32;

type Pkce = { readonly verifier: string; readonly challenge: string; readonly state: string };

type AuthorizationReply = {
  readonly code: string | undefined;
  readonly state: string | undefined;
  readonly error: string | undefined;
  /** Sign in with ChatGPT returns the app ID it issued on a first login. */
  readonly clientId: string | undefined;
};

/** The authorize page to open; Tau adds PKCE, `state` and `redirect_uri`. */
export type BrowserAuthorization = {
  readonly authorizeUrl: string;
  readonly params: Readonly<Record<string, string>>;
  readonly callback: LoginCallback;
};

/** What a completed browser login hands to the token exchange. */
export type AuthorizedCode = {
  readonly code: string;
  readonly verifier: string;
  readonly state: string;
  readonly redirectUri: string;
  readonly clientId: string | undefined;
};

const DeviceCode = Schema.Struct({
  device_auth_id: Schema.String,
  user_code: Schema.String,
  interval: Schema.Union([Schema.Finite, Schema.FiniteFromString]),
});

const DeviceAuthorization = Schema.Struct({
  authorization_code: Schema.String,
  code_verifier: Schema.String,
});

const DeviceError = Schema.Struct({
  error: Schema.Union([Schema.String, Schema.Struct({ code: Schema.String })]),
});

/** Logs in to `provider` with `method` and returns the issued tokens. */
export const logInWithOAuth = Effect.fn("logInWithOAuth")(
  function* (provider: ProviderId, oauth: OAuthClient, method: LoginMethod) {
    const issued =
      method === "browser"
        ? yield* browserLogin(provider, oauth)
        : yield* headlessLogin(provider, oauth, oauth.headless);

    return issued.tokens;
  },
  (effect, provider) => asLoginFailed(effect, provider),
);

type LoginRequestError = TokenRequestFailed | HttpClientError.HttpClientError | Schema.SchemaError;

const isLoginRequestError = (error: unknown): error is LoginRequestError =>
  Predicate.isTagged(error, "TokenRequestFailed") ||
  Predicate.isTagged(error, "HttpClientError") ||
  Predicate.isTagged(error, "SchemaError");

/** Turns a failed request during login into a `LoginFailed` that says to try again. */
export const asLoginFailed = <A, E, R>(effect: Effect.Effect<A, E, R>, provider: ProviderId) =>
  Effect.catchIf(effect, isLoginRequestError, (cause) =>
    Effect.fail(requestFailed(provider, cause)),
  );

/**
 * Opens the authorize page and waits for the browser to reach Tau's callback; a pasted address also
 * completes the login, for a browser on another machine. `exchange` runs while the callback server
 * is still open, so the browser receives its page before the server stops.
 */
export const authorizeInBrowser = <A, E, R>(
  provider: ProviderId,
  authorization: BrowserAuthorization,
  exchange: (authorized: AuthorizedCode) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const prompt = yield* LoginPrompt;
    const pkce = yield* makePkce;
    const { callback } = authorization;
    const server = yield* callbackServer(callback);

    const port = Option.match(server, {
      onNone: () => callback.port,
      onSome: (listening) => listening.port,
    });

    const redirectUri = `http://${callback.host}:${port}${callback.path}`;

    yield* prompt.openBrowser(
      authorizeAddress(authorization.authorizeUrl, authorization.params, pkce, redirectUri),
    );

    const pasted = prompt
      .ask("If the browser is on another machine, paste the address it ends on:")
      .pipe(Effect.map(replyFromAddress));

    const reply = Option.isSome(server)
      ? yield* Effect.raceFirst(server.value.reply, pasted)
      : yield* pasted;

    const code = yield* authorizationCode(provider, reply, pkce.state);

    return yield* exchange({
      code,
      verifier: pkce.verifier,
      state: pkce.state,
      redirectUri,
      clientId: reply.clientId,
    });
  }).pipe(Effect.scoped);

const browserLogin = (provider: ProviderId, oauth: OAuthClient) =>
  authorizeInBrowser(
    provider,
    {
      authorizeUrl: oauth.authorizeUrl,
      params: { client_id: oauth.clientId, scope: oauth.scopes, ...oauth.authorizeParams },
      callback: oauth.callback,
    },
    (authorized) =>
      requestTokens(provider, oauthTokenEndpoint(oauth), {
        grant_type: "authorization_code",
        code: authorized.code,
        code_verifier: authorized.verifier,
        redirect_uri: authorized.redirectUri,
        state: authorized.state,
      }),
  );

const headlessLogin = (provider: ProviderId, oauth: OAuthClient, headless: HeadlessLogin) =>
  headless.kind === "copyCode"
    ? copyCodeLogin(provider, oauth, headless.redirectUri)
    : deviceCodeLogin(provider, oauth, headless);

/** Claude's copy-code page shows `code#state` after the user logs in, for the user to paste. */
const copyCodeLogin = Effect.fn("copyCodeLogin")(function* (
  provider: ProviderId,
  oauth: OAuthClient,
  redirectUri: string,
) {
  const prompt = yield* LoginPrompt;
  const pkce = yield* makePkce;

  const params = { client_id: oauth.clientId, scope: oauth.scopes, ...oauth.authorizeParams };

  yield* prompt.show(
    `Open this address in a browser and log in:\n${authorizeAddress(oauth.authorizeUrl, params, pkce, redirectUri)}`,
  );

  const pasted = yield* prompt.ask("Paste the code the page shows:");
  const [code, state] = pasted.trim().split("#");
  const reply = { code, state, error: undefined, clientId: undefined };

  return yield* requestTokens(provider, oauthTokenEndpoint(oauth), {
    grant_type: "authorization_code",
    code: yield* authorizationCode(provider, reply, pkce.state),
    code_verifier: pkce.verifier,
    redirect_uri: redirectUri,
    state: pkce.state,
  });
});

/** ChatGPT shows a code to enter on its site, then hands Tau an authorization code once it is entered. */
const deviceCodeLogin = Effect.fn("deviceCodeLogin")(function* (
  provider: ProviderId,
  oauth: OAuthClient,
  device: Extract<HeadlessLogin, { readonly kind: "deviceCode" }>,
) {
  const client = yield* HttpClient.HttpClient;
  const prompt = yield* LoginPrompt;

  const started = yield* client
    .execute(postJson(device.userCodeUrl, { client_id: oauth.clientId }))
    .pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(HttpClientResponse.schemaBodyJson(DeviceCode)),
    );

  yield* prompt.show(`Open ${device.verificationUrl} and enter the code ${started.user_code}`);

  const authorization = yield* pollDeviceCode(provider, device, started).pipe(
    Effect.timeoutOrElse({
      duration: DEVICE_CODE_LIFETIME,
      orElse: () =>
        Effect.fail(
          new LoginFailed({
            provider,
            reason: "deviceCodeExpired",
            message: `The ${provider} device code expired before it was entered. Run tau login again.`,
          }),
        ),
    }),
  );

  return yield* requestTokens(provider, oauthTokenEndpoint(oauth), {
    grant_type: "authorization_code",
    code: authorization.authorization_code,
    code_verifier: authorization.code_verifier,
    redirect_uri: device.redirectUri,
    state: undefined,
  });
});

type DevicePollFailure = LoginFailed | HttpClientError.HttpClientError | Schema.SchemaError;

/** Polls until the user enters the code, waiting `interval` before each poll. */
const pollDeviceCode = (
  provider: ProviderId,
  device: Extract<HeadlessLogin, { readonly kind: "deviceCode" }>,
  started: typeof DeviceCode.Type,
) => {
  const request = postJson(device.pollUrl, {
    device_auth_id: started.device_auth_id,
    user_code: started.user_code,
  });

  const poll: (
    interval: Duration.Duration,
  ) => Effect.Effect<typeof DeviceAuthorization.Type, DevicePollFailure, HttpClient.HttpClient> =
    Effect.fn("pollDeviceCode")(function* (interval: Duration.Duration) {
      yield* Effect.sleep(interval);
      const response = yield* (yield* HttpClient.HttpClient).execute(request);

      if (response.status === HTTP_OK) {
        return yield* HttpClientResponse.schemaBodyJson(DeviceAuthorization)(response);
      }

      if (DEVICE_PENDING_STATUSES.includes(response.status)) return yield* poll(interval);

      const { error } = yield* HttpClientResponse.schemaBodyJson(DeviceError)(response);
      const code = Schema.is(Schema.String)(error) ? error : error.code;

      if (code === "slow_down") return yield* poll(Duration.sum(interval, SLOW_DOWN_STEP));
      if (code === "deviceauth_authorization_pending") return yield* poll(interval);
      return yield* denied(provider, code);
    });

  return poll(Duration.seconds(started.interval));
};

const makePkce = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const verifier = Base64Url.encode(yield* crypto.randomBytes(VERIFIER_BYTES));
  const digest = yield* crypto.digest("SHA-256", new TextEncoder().encode(verifier));
  const state = Base64Url.encode(yield* crypto.randomBytes(STATE_BYTES));
  return { verifier, challenge: Base64Url.encode(digest), state } satisfies Pkce;
  // The platform's secure random source and SHA-256 fail only when the platform is broken.
}).pipe(Effect.orDie);

const authorizeAddress = (
  authorizeUrl: string,
  params: Readonly<Record<string, string>>,
  pkce: Pkce,
  redirectUri: string,
) => {
  const query = new URLSearchParams({
    response_type: "code",
    redirect_uri: redirectUri,
    code_challenge: pkce.challenge,
    code_challenge_method: "S256",
    state: pkce.state,
    ...params,
  });

  return `${authorizeUrl}?${query.toString()}`;
};

/**
 * Listens on the loopback port the provider redirects to, for the life of the scope. When the port
 * is taken, says so and returns none, and the login continues with a pasted address.
 */
const callbackServer = (
  callback: LoginCallback,
): Effect.Effect<
  Option.Option<{ readonly port: number; readonly reply: Effect.Effect<AuthorizationReply> }>,
  never,
  LoginPrompt | Scope.Scope
> =>
  Effect.gen(function* () {
    const reply = yield* Deferred.make<AuthorizationReply>();

    const server = yield* Effect.acquireRelease(
      Effect.try({
        try: () =>
          Bun.serve({
            hostname: "127.0.0.1",
            port: callback.port,
            fetch: (request) => {
              const url = new URL(request.url);
              if (url.pathname !== callback.path) return new Response("Not found", { status: 404 });
              Deferred.doneUnsafe(reply, Exit.succeed(replyFromParams(url.searchParams)));
              return new Response("Tau received the login. You can close this tab.");
            },
          }),
        catch: (cause) => new CallbackUnavailable({ port: callback.port, cause }),
      }),
      (running) => Effect.promise(() => running.stop(true)),
    );

    return Option.some({ port: server.port ?? callback.port, reply: Deferred.await(reply) });
  }).pipe(
    Effect.catchTag("CallbackUnavailable", (unavailable) =>
      LoginPrompt.use((prompt) =>
        prompt.show(
          `Port ${unavailable.port} is in use, so the browser cannot return to Tau. Paste the address it ends on instead.`,
        ),
      ).pipe(Effect.as(Option.none())),
    ),
  );

const replyFromParams = (params: URLSearchParams): AuthorizationReply => ({
  code: params.get("code") ?? undefined,
  state: params.get("state") ?? undefined,
  error: params.get("error") ?? undefined,
  clientId: params.get("client_id") ?? undefined,
});

const replyFromAddress = (address: string) =>
  replyFromParams(URL.parse(address.trim())?.searchParams ?? new URLSearchParams());

/** The state must match this login's, so a reply from another login or another site is refused. */
const authorizationCode = (provider: ProviderId, reply: AuthorizationReply, state: string) => {
  if (reply.state !== state) {
    return Effect.fail(
      new LoginFailed({
        provider,
        reason: "stateMismatch",
        message: `That ${provider} reply belongs to a different login. Run tau login again and paste the newest address or code.`,
      }),
    );
  }

  if (reply.code === undefined) return denied(provider, reply.error ?? "no code in the reply");
  return Effect.succeed(reply.code);
};

const postJson = (url: string, body: Readonly<Record<string, string>>) =>
  HttpClientRequest.bodyJsonUnsafe(HttpClientRequest.post(url), body);

const denied = (provider: ProviderId, why: string) =>
  Effect.fail(
    new LoginFailed({
      provider,
      reason: "denied",
      message: `${provider} refused the login: ${why}. Run tau login to try again.`,
    }),
  );

const requestFailed = (provider: ProviderId, cause: Error) =>
  new LoginFailed({
    provider,
    reason: "requestFailed",
    message: `Logging in to ${provider} failed: ${cause.message}. Run tau login to try again.`,
    cause,
  });
