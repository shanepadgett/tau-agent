/**
 * The entries of a session, in Tau's own types. They are saved as JSON, so an Effect upgrade
 * cannot break saved sessions.
 */

import { type DateTime, Schema } from "effect";
import { RouteId } from "../ai/Routes.ts";

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

/**
 * The token counts a provider reported for one reply. A provider leaves out the counts it does
 * not report. The cache counts show whether the provider's prompt cache works.
 */
const Tokens = Schema.Struct({
  input: Schema.optional(Schema.Int),
  output: Schema.optional(Schema.Int),
  cacheRead: Schema.optional(Schema.Int),
  cacheWrite: Schema.optional(Schema.Int),
});

const UserEntry = Schema.Struct({ type: Schema.Literal("user"), text: Schema.String });

/**
 * An interrupted reply holds the text the model sent before the user or a crash stopped it. The
 * user sees it; later model calls leave it out. It has no token counts, because only a finished
 * reply reports them.
 */
const AssistantEntry = Schema.Struct({
  type: Schema.Literal("assistant"),
  model: Schema.Struct({ route: RouteId, model: Schema.String }),
  parts: Schema.Array(Schema.Union([TextPart, ReasoningPart, ToolCallPart])),
  interrupted: Schema.Boolean,
  tokens: Schema.optional(Tokens),
});

/**
 * Saved before a tool call runs. A call with this entry and no result was cut short, so Tau never
 * runs it again.
 */
const ToolStartedEntry = Schema.Struct({
  type: Schema.Literal("tool-started"),
  callId: Schema.String,
});

/**
 * `files` are the paths the script's file functions touched. Tau loads the agent instruction files
 * above them. A result Tau made itself, such as for a cancelled call, has none. `script` is the
 * code a `run` call ran, after any edits, so a later call can edit it again.
 */
const ToolResultEntry = Schema.Struct({
  type: Schema.Literal("tool-result"),
  callId: Schema.String,
  name: Schema.String,
  result: Schema.Json,
  isFailure: Schema.Boolean,
  files: Schema.optional(Schema.Array(Schema.String)),
  script: Schema.optional(Schema.String),
});

/**
 * What changed in the model's instructions, such as an instruction file or the date. `values` has
 * the new value of each changed source, or null for a source that has no value now. `text` is saved
 * as rendered, so a later change to the wording cannot change old requests. The first entry of a
 * session goes in the system prompt; the later ones are notes in the chat.
 */
const InstructionsEntry = Schema.Struct({
  type: Schema.Literal("instructions"),
  placement: Schema.Literals(["system", "note"]),
  values: Schema.Record(Schema.String, Schema.NullOr(Schema.String)),
  text: Schema.String,
});

export const EntryBody = Schema.Union([
  UserEntry,
  AssistantEntry,
  ToolStartedEntry,
  ToolResultEntry,
  InstructionsEntry,
]);

export type EntryBody = typeof EntryBody.Type;

/** `number` starts at 1 in each session and only grows. */
export type Entry = {
  readonly session: SessionId;
  readonly number: number;
  readonly at: DateTime.Utc;
  readonly body: EntryBody;
};
