/** Routes say which Effect AI package reaches a provider, at which URL, and how its requests authenticate. */

import { Schema } from "effect";
import { ProviderId } from "./credential.ts";

export const RouteId = Schema.String.pipe(Schema.brand("RouteId"));
export type RouteId = typeof RouteId.Type;

/** A subscription login changes more than the token: each one adds headers its provider checks. */
export type RouteAuth =
  | { readonly kind: "apiKey"; readonly environmentVariable: string }
  | { readonly kind: "claudeSubscription" }
  | { readonly kind: "chatgptSubscription" };

export type Route = {
  readonly id: RouteId;
  /** The credential the route uses. */
  readonly provider: ProviderId;
  readonly client: "anthropic" | "openai" | "openrouter";
  readonly apiUrl: string;
  readonly auth: RouteAuth;
  readonly decisions: "systemOne" | "openaiDecisions" | undefined;
};

export const builtInRoutes: ReadonlyArray<Route> = [
  {
    id: RouteId.make("anthropic"),
    provider: ProviderId.make("anthropic"),
    client: "anthropic",
    apiUrl: "https://api.anthropic.com",
    auth: { kind: "claudeSubscription" },
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
    id: RouteId.make("openai-codex"),
    provider: ProviderId.make("openai-codex"),
    client: "openai",
    apiUrl: "https://chatgpt.com/backend-api/codex",
    auth: { kind: "chatgptSubscription" },
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
