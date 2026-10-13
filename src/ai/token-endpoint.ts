/** Requests tokens from a subscription's OAuth token endpoint, when logging in and when a login is refreshed. */

import { DateTime, Duration, Effect, Redacted, Schema } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { OAuthTokens, ProviderId } from "./credential.ts";
import type { ChatgptApp, OAuthClient } from "./routes.ts";

/** Where and how a login's tokens are requested. */
export type TokenEndpoint = {
  readonly url: string;
  readonly clientId: string;
  /** Claude's endpoint takes JSON and checks the login's state again; the others take a standard OAuth form. */
  readonly format: "claudeJson" | "form";
  /** Sign in with ChatGPT names the API its tokens are for on every request. */
  readonly resource: string | undefined;
};

type IssuedTokens = {
  readonly tokens: OAuthTokens;
  /** Present when the login asked for OpenID scopes. */
  readonly idToken: string | undefined;
  readonly scopes: ReadonlyArray<string>;
};

export const oauthTokenEndpoint = (oauth: OAuthClient): TokenEndpoint => ({
  url: oauth.tokenUrl,
  clientId: oauth.clientId,
  format: oauth.tokenFormat,
  resource: undefined,
});

/** Sign in with ChatGPT requests tokens with the app ID OpenAI issued to Tau at registration. */
export const chatgptAppTokenEndpoint = (app: ChatgptApp, clientId: string): TokenEndpoint => ({
  url: app.tokenUrl,
  clientId,
  format: "form",
  resource: app.resource,
});

/** Field names follow the OAuth standard, so a grant is sent as written. */
export type TokenGrant =
  | {
      readonly grant_type: "authorization_code";
      readonly code: string;
      readonly code_verifier: string;
      readonly redirect_uri: string;
      /** Claude checks it again; logins without one, such as ChatGPT's device code, leave it out. */
      readonly state: string | undefined;
    }
  | { readonly grant_type: "refresh_token"; readonly refresh_token: string };

const TokenResponse = Schema.Struct({
  access_token: Schema.String,
  // Providers replace the refresh token on every use, so the old one stops working.
  refresh_token: Schema.String,
  expires_in: Schema.Number,
  id_token: Schema.optional(Schema.String),
  scope: Schema.optional(Schema.String),
});

const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;

/** The endpoint answers these when the code, verifier or refresh token is no longer valid. */
const REFUSED_STATUSES = [HTTP_BAD_REQUEST, HTTP_UNAUTHORIZED];

export class TokenRequestFailed extends Schema.TaggedError<TokenRequestFailed>()(
  "TokenRequestFailed",
  {
    provider: ProviderId,
    /** `refused` means only a new login can fix it; `failed` may pass on a later attempt. */
    reason: Schema.Literals(["refused", "failed"]),
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export const requestTokens = Effect.fn("requestTokens")(
  function* (provider: ProviderId, endpoint: TokenEndpoint, grant: TokenGrant) {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.execute(tokenRequest(endpoint, grant));

    if (REFUSED_STATUSES.includes(response.status)) {
      return yield* new TokenRequestFailed({
        provider,
        reason: "refused",
        message: `${provider} refused the token request (${response.status}): ${yield* response.text}`,
      });
    }

    const tokens = yield* HttpClientResponse.filterStatusOk(response).pipe(
      Effect.flatMap(HttpClientResponse.schemaBodyJson(TokenResponse)),
    );

    const issued: IssuedTokens = {
      tokens: OAuthTokens.make({
        access: Redacted.make(tokens.access_token),
        refresh: Redacted.make(tokens.refresh_token),
        expiresAt: DateTime.addDuration(yield* DateTime.now, Duration.seconds(tokens.expires_in)),
      }),
      idToken: tokens.id_token,
      scopes: tokens.scope?.split(" ") ?? [],
    };

    return issued;
  },
  (effect, provider) =>
    Effect.catchTags(effect, {
      HttpClientError: (cause) => Effect.fail(failed(provider, cause)),
      SchemaError: (cause) => Effect.fail(failed(provider, cause)),
    }),
);

const tokenRequest = (endpoint: TokenEndpoint, grant: TokenGrant) => {
  const request = HttpClientRequest.post(endpoint.url);
  const fields = { ...grant, client_id: endpoint.clientId, resource: endpoint.resource };
  if (endpoint.format === "claudeJson") return HttpClientRequest.bodyJsonUnsafe(request, fields);

  // The standard form carries no state; an undefined field is left out.
  return HttpClientRequest.bodyUrlParams(request, { ...fields, state: undefined });
};

const failed = (provider: ProviderId, cause: Error) =>
  new TokenRequestFailed({
    provider,
    reason: "failed",
    message: `${provider} token request failed: ${cause.message}`,
    cause,
  });
