/**
 * Writes a thinking level into a model request. Each protocol names thinking its own way, so the
 * level becomes the fields that protocol reads, and Tau adds them to each request body.
 */

import { Option, Predicate, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import type { ModelProfile, Thinking, ThinkingLevel } from "../../ModelProfile.ts";

type Fields = Readonly<Record<string, Schema.Json>>;

const JsonFields = Schema.Record(Schema.String, Schema.Json);
const decodeBody = Schema.decodeUnknownOption(Schema.fromJsonString(JsonFields));

/** Thinking tokens for each level of a model that takes a budget. */
const BUDGET_TOKENS: Partial<Record<ThinkingLevel, number>> = {
  low: 4096,
  medium: 10_240,
  high: 24_576,
  max: 65_536,
};

/** The request fields for `level`, which the model offers. No fields when there is nothing to send. */
export const thinkingFields = (profile: ModelProfile, level: ThinkingLevel): Fields => {
  const { thinking } = profile;
  if (thinking === undefined) return {};

  switch (profile.protocol) {
    case "anthropic":
      return anthropicFields(thinking, level, profile.outputTokens);

    case "openaiResponses":
      return thinking.kind === "effort" ? { reasoning: { effort: effortOf(thinking, level) } } : {};

    case "openrouter":
      return { reasoning: openRouterReasoning(thinking, level, profile.outputTokens) };

    case "openaiChat":
      return openAiChatFields(thinking, level, profile.outputTokens);
  }
};

/** Adds `fields` to each JSON request body, merging objects one level deep. */
export const withRequestFields = (
  client: HttpClient.HttpClient,
  fields: Fields,
): HttpClient.HttpClient =>
  Object.keys(fields).length === 0
    ? client
    : HttpClient.mapRequest(client, (request) => withFields(request, fields));

const withFields = (request: HttpClientRequest.HttpClientRequest, fields: Fields) => {
  if (!Predicate.isTagged(request.body, "Uint8Array")) return request;

  const body = decodeBody(new TextDecoder().decode(request.body.body));
  if (Option.isNone(body)) return request;

  const merged: Record<string, Schema.Json> = { ...body.value };

  for (const [key, value] of Object.entries(fields)) {
    const before = merged[key];

    merged[key] =
      isObject(before) && isObject(value)
        ? Object.fromEntries([...Object.entries(before), ...Object.entries(value)])
        : value;
  }

  return HttpClientRequest.bodyJsonUnsafe(request, merged);
};

const isObject = (value: Schema.Json | undefined): value is Readonly<Record<string, Schema.Json>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The provider's word for `level`. `off` with no word of its own is `none`. */
const effortOf = (thinking: Extract<Thinking, { kind: "effort" }>, level: ThinkingLevel) =>
  thinking.values[level] ?? "none";

/** The budget for `level`, inside the model's limits and below its output limit. */
const budgetOf = (
  thinking: Extract<Thinking, { kind: "budget" }>,
  level: ThinkingLevel,
  outputTokens: number,
) => {
  const wanted = BUDGET_TOKENS[level] ?? thinking.minTokens;
  const ceiling = Math.min(thinking.maxTokens ?? wanted, Math.floor(outputTokens / 2));
  return Math.max(thinking.minTokens, Math.min(wanted, ceiling));
};

const anthropicFields = (
  thinking: Thinking,
  level: ThinkingLevel,
  outputTokens: number,
): Fields => {
  if (level === "off") return { thinking: { type: "disabled" } };

  switch (thinking.kind) {
    case "toggle":
      return { thinking: { type: "adaptive" } };

    case "effort":
      return {
        thinking: { type: "adaptive" },
        output_config: { effort: effortOf(thinking, level) },
      };

    case "budget":
      return {
        max_tokens: outputTokens,
        thinking: { type: "enabled", budget_tokens: budgetOf(thinking, level, outputTokens) },
      };
  }
};

const openRouterReasoning = (
  thinking: Thinking,
  level: ThinkingLevel,
  outputTokens: number,
): Schema.Json => {
  if (level === "off" && !(thinking.kind === "effort" && thinking.values.off !== undefined)) {
    return { enabled: false };
  }

  switch (thinking.kind) {
    case "toggle":
      return { enabled: true };

    case "effort":
      return { effort: effortOf(thinking, level) };

    case "budget":
      return { max_tokens: budgetOf(thinking, level, outputTokens) };
  }
};

const openAiChatFields = (
  thinking: Thinking,
  level: ThinkingLevel,
  outputTokens: number,
): Fields => {
  if (level === "off" && !(thinking.kind === "effort" && thinking.values.off !== undefined)) {
    return { thinking: { type: "disabled" } };
  }

  switch (thinking.kind) {
    case "toggle":
      return { thinking: { type: "enabled" } };

    case "effort":
      return { reasoning_effort: effortOf(thinking, level) };

    case "budget":
      return {
        thinking: { type: "enabled", budget_tokens: budgetOf(thinking, level, outputTokens) },
      };
  }
};
