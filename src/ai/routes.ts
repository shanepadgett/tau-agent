/** Routes say which Effect AI package reaches a provider, at which URL, and how its requests authenticate. */

import { Schema } from "effect";
import { ProviderId } from "./credential.ts";

export const RouteId = Schema.String.pipe(Schema.brand("RouteId"));
export type RouteId = typeof RouteId.Type;

/** How to log in on a machine whose browser cannot reach Tau's callback, such as over SSH. */
export type HeadlessLogin =
  /** The provider's page shows `code#state` for the user to paste. */
  | { readonly kind: "copyCode"; readonly redirectUri: string }
  /** The user enters a short code on the provider's site while Tau polls for the result. */
  | {
      readonly kind: "deviceCode";
      readonly userCodeUrl: string;
      readonly pollUrl: string;
      readonly verificationUrl: string;
      readonly redirectUri: string;
    };

/** Where the browser returns after login. Tests use port 0. */
export type LoginCallback = {
  /** The host written in the redirect address; Tau always listens on 127.0.0.1. */
  readonly host: "localhost" | "127.0.0.1";
  readonly port: number;
  readonly path: string;
};

/** A subscription's OAuth client. Tests point the URLs at a fake server and the callback at port 0. */
export type OAuthClient = {
  readonly clientId: string;
  readonly authorizeUrl: string;
  readonly tokenUrl: string;
  readonly scopes: string;
  readonly authorizeParams: Readonly<Record<string, string>>;
  /** Claude's endpoint takes JSON and checks the login's state again; OpenAI's takes a standard OAuth form. */
  readonly tokenFormat: "claudeJson" | "form";
  readonly callback: LoginCallback;
  readonly headless: HeadlessLogin;
};

/**
 * Sign in with ChatGPT for open-source apps: Tau registers as its own app on the user's account,
 * and its requests spend the user's ChatGPT plan on the public API. Tests point the URLs at a fake.
 */
export type ChatgptApp = {
  readonly authorizeUrl: string;
  readonly tokenUrl: string;
  readonly revokeUrl: string;
  readonly jwksUrl: string;
  readonly issuer: string;
  /** Sent with every authorize and token request; the tokens work only on this API. */
  readonly resource: string;
  readonly scopes: string;
  /** The name a first login suggests for the app on the user's account. */
  readonly agentName: string;
  readonly callback: LoginCallback;
};

/** A subscription login changes more than the token: each one adds headers its provider checks. */
export type RouteAuth =
  | { readonly kind: "apiKey"; readonly environmentVariable: string }
  | { readonly kind: "claudeSubscription"; readonly oauth: OAuthClient }
  | { readonly kind: "codexLogin"; readonly oauth: OAuthClient }
  | { readonly kind: "chatgptApp"; readonly app: ChatgptApp };

export type Route = {
  readonly id: RouteId;
  /** The credential the route uses. */
  readonly provider: ProviderId;
  readonly client: "anthropic" | "openai" | "openrouter";
  readonly apiUrl: string;
  readonly auth: RouteAuth;
  readonly decisions: "systemOne" | "openaiDecisions" | undefined;
};

// Both clients are the providers' own CLI clients, which these subscription logins require.
const claudeOAuth: OAuthClient = {
  clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
  authorizeUrl: "https://claude.ai/oauth/authorize",
  tokenUrl: "https://platform.claude.com/v1/oauth/token",
  scopes:
    "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload",
  authorizeParams: { code: "true" },
  tokenFormat: "claudeJson",
  callback: { host: "localhost", port: 53692, path: "/callback" },
  headless: { kind: "copyCode", redirectUri: "https://platform.claude.com/oauth/code/callback" },
};

const codexOAuth: OAuthClient = {
  clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
  authorizeUrl: "https://auth.openai.com/oauth/authorize",
  tokenUrl: "https://auth.openai.com/oauth/token",
  scopes: "openid profile email offline_access",
  authorizeParams: {
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    originator: "tau",
  },
  tokenFormat: "form",
  // OpenAI accepts only this port, which the Codex CLI also uses.
  callback: { host: "localhost", port: 1455, path: "/auth/callback" },
  headless: {
    kind: "deviceCode",
    userCodeUrl: "https://auth.openai.com/api/accounts/deviceauth/usercode",
    pollUrl: "https://auth.openai.com/api/accounts/deviceauth/token",
    verificationUrl: "https://auth.openai.com/codex/device",
    redirectUri: "https://auth.openai.com/deviceauth/callback",
  },
};

const chatgptApp: ChatgptApp = {
  authorizeUrl: "https://auth.openai.com/api/accounts/authorize",
  tokenUrl: "https://auth.openai.com/api/accounts/oauth/token",
  revokeUrl: "https://auth.openai.com/api/accounts/oauth/revoke",
  jwksUrl: "https://auth.openai.com/.well-known/jwks.json",
  issuer: "https://auth.openai.com",
  resource: "https://api.openai.com/v1",
  scopes: "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
  agentName: "Tau",
  // OpenAI requires 127.0.0.1 in the redirect address, never localhost.
  callback: { host: "127.0.0.1", port: 1455, path: "/auth/callback" },
};

export const builtInRoutes: ReadonlyArray<Route> = [
  {
    id: RouteId.make("anthropic"),
    provider: ProviderId.make("anthropic"),
    client: "anthropic",
    apiUrl: "https://api.anthropic.com",
    auth: { kind: "claudeSubscription", oauth: claudeOAuth },
    decisions: undefined,
  },
  {
    id: RouteId.make("openai"),
    provider: ProviderId.make("openai"),
    client: "openai",
    apiUrl: "https://api.openai.com/v1",
    auth: { kind: "apiKey", environmentVariable: "OPENAI_API_KEY" },
    decisions: "openaiDecisions",
  },
  {
    id: RouteId.make("chatgpt"),
    provider: ProviderId.make("chatgpt"),
    client: "openai",
    apiUrl: "https://api.openai.com/v1",
    auth: { kind: "chatgptApp", app: chatgptApp },
    decisions: undefined,
  },
  {
    id: RouteId.make("codex"),
    provider: ProviderId.make("codex"),
    client: "openai",
    apiUrl: "https://chatgpt.com/backend-api/codex",
    auth: { kind: "codexLogin", oauth: codexOAuth },
    decisions: undefined,
  },
  {
    id: RouteId.make("openrouter"),
    provider: ProviderId.make("openrouter"),
    client: "openrouter",
    apiUrl: "https://openrouter.ai/api/v1",
    auth: { kind: "apiKey", environmentVariable: "OPENROUTER_API_KEY" },
    decisions: "systemOne",
  },
];
