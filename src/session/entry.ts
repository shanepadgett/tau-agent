/**
 * The entries of a session, in Tau's own types. They are saved as JSON, so an Effect upgrade
 * cannot break saved sessions.
 */

import { type DateTime, Schema } from "effect";
import { RouteId } from "../ai/routes.ts";

export const SessionId = Schema.String.pipe(Schema.brand("SessionId"));
export type SessionId = typeof SessionId.Type;

/**
 * Data that a provider needs back on the next request, such as a thinking signature, keyed by
 * provider. Tau does not read it.
 */
const ProviderData = Schema.Record(Schema.String, Schema.NullOr(Schema.Json));

const TextPart = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.String,
  providerData: ProviderData,
});

const ReasoningPart = Schema.Struct({
  type: Schema.Literal("reasoning"),
  text: Schema.String,
  providerData: ProviderData,
});

const ToolCallPart = Schema.Struct({
  type: Schema.Literal("tool-call"),
  id: Schema.String,
  name: Schema.String,
  params: Schema.Json,
  providerData: ProviderData,
});

const UserEntry = Schema.Struct({ type: Schema.Literal("user"), text: Schema.String });

const AssistantEntry = Schema.Struct({
  type: Schema.Literal("assistant"),
  model: Schema.Struct({ route: RouteId, model: Schema.String }),
  parts: Schema.Array(Schema.Union([TextPart, ReasoningPart, ToolCallPart])),
});

const ToolResultEntry = Schema.Struct({
  type: Schema.Literal("tool-result"),
  callId: Schema.String,
  name: Schema.String,
  result: Schema.Json,
  isFailure: Schema.Boolean,
});

export const EntryBody = Schema.Union([UserEntry, AssistantEntry, ToolResultEntry]);
export type EntryBody = typeof EntryBody.Type;

/** `number` starts at 1 in each session and only grows. */
export type Entry = {
  readonly session: SessionId;
  readonly number: number;
  readonly at: DateTime.Utc;
  readonly body: EntryBody;
};
