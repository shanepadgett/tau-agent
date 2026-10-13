/**
 * Adds the Claude Code headers and system text to Claude subscription requests. Anthropic refuses
 * subscription tokens without them.
 */

import { Option, Predicate, Schema } from "effect";
import { HttpClientRequest } from "effect/http";

const BETAS = ["claude-code-20250219", "oauth-2025-04-20"];

// Without both the client headers and the identity, Anthropic answers 429 with no rate-limit details.
const IDENTITY = {
  type: "text",
  text: "You are Claude Code, Anthropic's official CLI for Claude.",
};

const JsonFields = Schema.Record(Schema.String, Schema.Json);

const MessagesBody = Schema.fromJsonString(
  Schema.StructWithRest(Schema.Struct({ system: Schema.optional(Schema.Array(JsonFields)) }), [
    JsonFields,
  ]),
);

const decodeMessagesBody = Schema.decodeUnknownOption(MessagesBody);

/** `version` is a Claude Code release. The model catalog keeps it current. */
export const asClaudeCode = (request: HttpClientRequest.HttpClientRequest, version: string) =>
  withIdentity(
    HttpClientRequest.setHeaders(request, {
      "anthropic-beta": betasFor(request),
      "user-agent": `claude-cli/${version}`,
      "x-app": "cli",
    }),
  );

/** Appends Claude Code's betas after any the package itself requested. */
const betasFor = (request: HttpClientRequest.HttpClientRequest) => {
  const requested = request.headers["anthropic-beta"];
  return (requested === undefined ? BETAS : [requested, ...BETAS]).join(",");
};

const withIdentity = (request: HttpClientRequest.HttpClientRequest) => {
  if (!Predicate.isTagged(request.body, "Uint8Array")) return request;

  const body = decodeMessagesBody(new TextDecoder().decode(request.body.body));
  if (Option.isNone(body)) return request;

  const system = [IDENTITY, ...(body.value.system ?? [])];
  return HttpClientRequest.bodyJsonUnsafe(request, { ...body.value, system });
};
