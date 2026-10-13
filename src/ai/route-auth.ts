/** Signs each request with the credential of the route. Tau reads the credential for each request, and refreshes a login that is about to expire. */

import { Config, DateTime, Duration, Effect, Option, Predicate, Redacted, Schema } from "effect";
import { HttpClient, HttpClientError, HttpClientRequest } from "effect/http";
import packageJson from "../../package.json" with { type: "json" };
import { asClaudeCode } from "./claude-code.ts";
import {
  ApiKey,
  ChatgptAppTokens,
  type Credential,
  CredentialStore,
  OAuthTokens,
  ProviderId,
} from "./credential.ts";
import type { Protocol } from "./model-profile.ts";
import type { Route } from "./routes.ts";
import {
  chatgptAppTokenEndpoint,
  oauthTokenEndpoint,
  requestTokens,
  type TokenRequestFailed,
} from "./token-endpoint.ts";

/** A token this close to expiry counts as expired, so it cannot lapse while a request is in flight. */
const EXPIRY_MARGIN = Duration.minutes(1);

const UNAVAILABLE_REASONS = {
  missing:
    "has no stored credential and no API key in its environment variable. Run tau login, or set the environment variable.",
  expired: "login has expired. Run tau login.",
  refreshFailed: "login could not be refreshed. Try again; if it keeps failing, run tau login.",
  wrongKind:
    "credential is the wrong kind for this route: an API key where a subscription login is needed, or the reverse. Run tau login and choose this provider again.",
  unreadableToken: "access token has no ChatGPT account ID. Run tau login.",
};

type UnavailableReason = keyof typeof UNAVAILABLE_REASONS;

export class CredentialUnavailable extends Schema.TaggedError<CredentialUnavailable>()(
  "CredentialUnavailable",
  {
    provider: ProviderId,
    reason: Schema.Literals([
      "missing",
      "expired",
      "refreshFailed",
      "wrongKind",
      "unreadableToken",
    ]),
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

const unavailableFields = (route: Route, reason: UnavailableReason) => ({
  provider: route.provider,
  reason,
  message: `${route.provider} ${UNAVAILABLE_REASONS[reason]}`,
});

/** The ChatGPT account ID that Codex requires as a header is a claim in the access token. */
const ChatgptAccessToken = Schema.StringFromBase64Url.pipe(
  Schema.decodeTo(
    Schema.fromJsonString(
      Schema.Struct({
        "https://api.openai.com/auth": Schema.Struct({ chatgpt_account_id: Schema.String }),
      }),
    ),
  ),
);

type Sign = (request: HttpClientRequest.HttpClientRequest) => HttpClientRequest.HttpClientRequest;

/** One conversation with a model. Some providers use it to route requests and to cache prompts. */
export const ConversationId = Schema.String.pipe(Schema.brand("ConversationId"));
export type ConversationId = typeof ConversationId.Type;

/**
 * Data that signing needs in addition to the credential. The models on one route can use different
 * protocols.
 */
export type RequestSigning = {
  readonly protocol: Protocol;
  /** The Claude Code release that a Claude subscription request identifies as. */
  readonly claudeCodeVersion: string;
  /** Undefined for a request that is not part of a conversation, such as a model list. */
  readonly conversationId: ConversationId | undefined;
};

const TAU_USER_AGENT = `tau/${packageJson.version}`;

const unsigned: Sign = (request) => request;

/**
 * Reads the route's credential and returns what signs a request with it. Fails when the credential
 * is missing, the wrong kind, or a login that cannot be refreshed, so callers can check a route
 * before sending anything.
 */
export const credentialSigner = Effect.fn("credentialSigner")(function* (
  route: Route,
  signing: RequestSigning,
) {
  const signWithCredential = yield* credentialOnlySigner(route, signing);

  return (request: HttpClientRequest.HttpClientRequest) =>
    withClientHeaders(signWithCredential(request), route, signing);
});

/**
 * Names Tau as the client. Claude subscription requests must look like Claude Code, so they do not
 * name Tau. OpenCode Go also needs the conversation ID to route requests and cache prompts.
 */
const withClientHeaders = (
  request: HttpClientRequest.HttpClientRequest,
  route: Route,
  signing: RequestSigning,
) => {
  if (route.auth.kind === "claudeSubscription") return request;
  const named = HttpClientRequest.setHeader(request, "user-agent", TAU_USER_AGENT);
  const { conversationId } = signing;
  if (route.conversationHeaders !== "opencode" || conversationId === undefined) return named;

  return HttpClientRequest.setHeaders(named, {
    "x-opencode-session": conversationId,
    "x-opencode-client": "tau",
  });
};

const credentialOnlySigner = Effect.fn("credentialOnlySigner")(function* (
  route: Route,
  signing: RequestSigning,
) {
  if (route.auth.kind === "none") return unsigned;
  const credential = yield* currentCredential(route);

  if (route.auth.kind === "apiKey") {
    if (!Predicate.isTagged(credential, "ApiKey")) return yield* unavailable(route, "wrongKind");
    return apiKeySigner(signing.protocol, credential.key);
  }

  if (route.auth.kind === "chatgptApp") {
    const { app } = route.auth;

    if (!Predicate.isTagged(credential, "ChatgptAppTokens"))
      return yield* unavailable(route, "wrongKind");

    const refresh = (stale: ChatgptAppTokens) =>
      requestTokens(route.provider, chatgptAppTokenEndpoint(app, stale.clientId), {
        grant_type: "refresh_token",
        refresh_token: Redacted.value(stale.refresh),
      }).pipe(
        // A refreshed ID token carries no nonce; it is kept only as the next login's hint.
        Effect.map(({ tokens, idToken }) =>
          ChatgptAppTokens.make({
            clientId: stale.clientId,
            idToken: idToken === undefined ? stale.idToken : Redacted.make(idToken),
            access: tokens.access,
            refresh: tokens.refresh,
            expiresAt: tokens.expiresAt,
          }),
        ),
      );

    const fresh = yield* freshTokens(route, credential, Schema.is(ChatgptAppTokens), refresh);
    return HttpClientRequest.bearerToken(fresh.access);
  }

  if (!Predicate.isTagged(credential, "OAuthTokens")) return yield* unavailable(route, "wrongKind");

  const endpoint = oauthTokenEndpoint(route.auth.oauth);

  const refreshOAuth = (stale: OAuthTokens) =>
    requestTokens(route.provider, endpoint, {
      grant_type: "refresh_token",
      refresh_token: Redacted.value(stale.refresh),
    }).pipe(Effect.map((issued) => issued.tokens));

  const tokens = yield* freshTokens(route, credential, Schema.is(OAuthTokens), refreshOAuth);
  const signWithToken = HttpClientRequest.bearerToken(tokens.access);

  if (route.auth.kind === "claudeSubscription")
    return (request) => asClaudeCode(signWithToken(request), signing.claudeCodeVersion);

  const accountId = yield* chatgptAccountId(route, Redacted.value(tokens.access));

  return (request: HttpClientRequest.HttpClientRequest) =>
    HttpClientRequest.setHeaders(signWithToken(request), {
      "chatgpt-account-id": accountId,
      originator: "tau",
      "OpenAI-Beta": "responses=experimental",
    });
});

/**
 * Signs every request the client sends. A credential failure becomes a transport error, because
 * Effect's AI clients accept only HTTP errors from a client transform.
 */
export const signRequests = Effect.fn("signRequests")(function* (
  route: Route,
  signing: RequestSigning,
) {
  const context = yield* Effect.context<CredentialStore | HttpClient.HttpClient>();

  return (client: HttpClient.HttpClient) =>
    HttpClient.mapRequestEffect(client, (request) =>
      credentialSigner(route, signing).pipe(
        Effect.map((sign) => sign(request)),
        Effect.provideContext(context),
        Effect.mapError(
          (cause) =>
            new HttpClientError.HttpClientError({
              reason: new HttpClientError.TransportError({
                request,
                cause,
                description: cause.message,
              }),
            }),
        ),
      ),
    );
});

/** The stored credential, or an API key from the route's environment variable when none is stored. */
const currentCredential = Effect.fn("currentCredential")(function* (route: Route) {
  const store = yield* CredentialStore;
  const stored: Option.Option<Credential> = yield* store.read(route.provider);
  if (Option.isSome(stored)) return stored.value;
  if (route.auth.kind !== "apiKey") return yield* unavailable(route, "missing");

  // An unset variable is `none`; reading the environment itself cannot fail.
  const key = yield* Config.option(Config.Redacted(route.auth.environmentVariable)).pipe(
    Effect.orDie,
  );

  if (Option.isNone(key)) return yield* unavailable(route, "missing");
  return ApiKey.make({ key: key.value });
});

/**
 * Returns `tokens`, or refreshed ones when they expire within a minute. Requests that find the same
 * expired tokens wait for one refresh, in this process or another, and use its result.
 */
const freshTokens = Effect.fn("freshTokens")(function* <
  Tokens extends OAuthTokens | ChatgptAppTokens,
>(
  route: Route,
  tokens: Tokens,
  isSameKind: (credential: Credential) => credential is Tokens,
  refresh: (stale: Tokens) => Effect.Effect<Tokens, TokenRequestFailed, HttpClient.HttpClient>,
) {
  const expiresSoon = DateTime.isLessThan(
    tokens.expiresAt,
    DateTime.addDuration(yield* DateTime.now, EXPIRY_MARGIN),
  );

  if (!expiresSoon) return tokens;

  const store = yield* CredentialStore;
  const client = yield* HttpClient.HttpClient;

  // `update` hands back `tokens` itself as the stale credential, so `refresh` can take them typed.
  const refreshStored = () =>
    refresh(tokens).pipe(Effect.provideService(HttpClient.HttpClient, client));

  const updated = yield* store
    .update(route.provider, tokens, refreshStored)
    .pipe(Effect.catchTag("TokenRequestFailed", (cause) => refreshUnavailable(route, cause)));

  if (Option.isNone(updated)) return yield* unavailable(route, "missing");
  if (!isSameKind(updated.value)) return yield* unavailable(route, "wrongKind");
  return updated.value;
});

const refreshUnavailable = (route: Route, cause: TokenRequestFailed) => {
  const reason = cause.reason === "refused" ? "expired" : "refreshFailed";
  const fields = unavailableFields(route, reason);

  return Effect.fail(
    new CredentialUnavailable({
      ...fields,
      message: `${fields.message} (${cause.message})`,
      cause,
    }),
  );
};

const apiKeySigner = (protocol: Protocol, key: Redacted.Redacted): Sign =>
  protocol === "anthropic"
    ? HttpClientRequest.setHeader("x-api-key", Redacted.value(key))
    : HttpClientRequest.bearerToken(key);

const chatgptAccountId = (route: Route, accessToken: string) => {
  const [, payload = ""] = accessToken.split(".");

  return Schema.decodeUnknownEffect(ChatgptAccessToken)(payload).pipe(
    Effect.map((claims) => claims["https://api.openai.com/auth"].chatgpt_account_id),
    Effect.mapError(
      (cause) =>
        new CredentialUnavailable({ ...unavailableFields(route, "unreadableToken"), cause }),
    ),
  );
};

const unavailable = (route: Route, reason: UnavailableReason) =>
  Effect.fail(new CredentialUnavailable(unavailableFields(route, reason)));
