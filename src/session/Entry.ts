/**
 * The entries of a session, in Tau's own types. They are saved as JSON, so an Effect upgrade
 * cannot break saved sessions.
 */

import { type DateTime, Schema } from "effect";
import { ThinkingLevel } from "../ai/ModelProfile.ts";
import { ProviderId } from "../ai/Providers.ts";
import { CheckReport } from "./CheckReport.ts";
import { Question } from "./Questions.ts";

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

/**
 * A prompt starts a run. A steering message is one the user sent during a run; the run takes it
 * before its next model call and goes on.
 */
const UserEntry = Schema.Struct({
  type: Schema.Literal("user"),
  text: Schema.String,
  steering: Schema.optional(Schema.Literal(true)),
});

/**
 * An interrupted reply holds the text the model sent before the user or a crash stopped it. The
 * user sees it; later model calls leave it out. It has no token counts, because only a finished
 * reply reports them.
 */
const AssistantEntry = Schema.Struct({
  type: Schema.Literal("assistant"),
  /** `thinking` is the level the user chose for the run; replies saved before levels have none. */
  model: Schema.Struct({
    provider: ProviderId,
    model: Schema.String,
    thinking: Schema.optional(ThinkingLevel),
  }),
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
 * The files a script changed, as paths from the repository root. They are unknown outside git, or
 * when git cannot tell.
 */
const Changes = Schema.Union([
  Schema.Struct({ type: Schema.Literal("files"), paths: Schema.Array(Schema.String) }),
  Schema.Struct({ type: Schema.Literal("unknown") }),
]);

export type Changes = typeof Changes.Type;

/**
 * `script` is the code the call ran, after any edits, so a later call can edit it again; a call
 * that ran nothing has none. `files` are the full paths the script's file functions touched; Tau
 * loads the agent instruction files above them. `changes` is there only when the project has
 * checks.
 */
const RunDetails = Schema.Struct({
  tool: Schema.Literal("run"),
  script: Schema.optional(Schema.String),
  files: Schema.Array(Schema.String),
  changes: Schema.optional(Changes),
  output: Schema.optional(Schema.String),
});

const ChecksDetails = Schema.Struct({
  tool: Schema.Literal("checks"),
  report: CheckReport,
  output: Schema.optional(Schema.String),
});

/** A command the agent left running, as a checkpoint lists it. */
const RunningProcess = Schema.Struct({
  id: Schema.String,
  command: Schema.String,
  pty: Schema.Boolean,
});

export type RunningProcess = typeof RunningProcess.Type;

const CheckpointDetails = Schema.Struct({
  tool: Schema.Literal("checkpoint"),
  handoff: Schema.String,
  longTerm: Schema.optional(Schema.Int),
  shortTerm: Schema.Array(Schema.Int),
  shortTermTokens: Schema.Int,
  tailFrom: Schema.Int,
  /** The commands running at the checkpoint. Absent on checkpoints saved before process sessions. */
  processes: Schema.optional(Schema.Array(RunningProcess)),
});

export type CheckpointDetails = typeof CheckpointDetails.Type;

/** The questions an `ask_question` call put to the user, kept so the client can show them. */
const QuestionsDetails = Schema.Struct({
  tool: Schema.Literal("ask_question"),
  questions: Schema.Array(Question),
});

const ToolDetails = Schema.Union([RunDetails, ChecksDetails, CheckpointDetails, QuestionsDetails]);
export type ToolDetails = typeof ToolDetails.Type;

/**
 * `details` hold what the tool that made the result needs later. A result Tau made itself, such
 * as for a cancelled call or a tool that does not exist, has none.
 */
const ToolResultEntry = Schema.Struct({
  type: Schema.Literal("tool-result"),
  callId: Schema.String,
  name: Schema.String,
  result: Schema.Json,
  isFailure: Schema.Boolean,
  details: Schema.optional(ToolDetails),
});

/**
 * The project's checks, run by Tau when the model ended its turn without running the checks for
 * its last changes. A report with failures goes to the model; a passing one does not.
 */
const ChecksEntry = Schema.Struct({ type: Schema.Literal("checks"), report: CheckReport });

/**
 * What changed in the model's instructions, such as an instruction file or the date. `values` has
 * the new value of each changed source, or null for a source that has no value now. `text` is saved
 * as rendered, so a later change to the wording cannot change old requests. The first entry of a
 * session goes in the system prompt; the later ones are updates in the chat.
 */
const InstructionsEntry = Schema.Struct({
  type: Schema.Literal("instructions"),
  placement: Schema.Literals(["system", "update"]),
  values: Schema.Record(Schema.String, Schema.NullOr(Schema.String)),
  text: Schema.String,
});

/** Hidden from the chat; read by the model at its position in the conversation. */
const NudgeEntry = Schema.Struct({
  type: Schema.Literal("nudge"),
  key: Schema.String,
  text: Schema.String,
});

export type NudgeEntry = typeof NudgeEntry.Type;

/**
 * The folders a user message tagged, each listed one level deep as the message was sent. Hidden from
 * the chat; saved once, so later model calls send the same text.
 */
const FolderListingsEntry = Schema.Struct({
  type: Schema.Literal("folder-listings"),
  text: Schema.String,
});

/**
 * The reference repositories the user attached to the session, saved on each change; the newest
 * entry holds the current list.
 */
const ReferencesEntry = Schema.Struct({
  type: Schema.Literal("references"),
  names: Schema.Array(Schema.String),
});

/** A run that ended with an error, with the text the chat showed. Not saved for a cancelled run. */
const RunFailedEntry = Schema.Struct({ type: Schema.Literal("run-failed"), error: Schema.String });

export const EntryBody = Schema.Union([
  UserEntry,
  AssistantEntry,
  ToolStartedEntry,
  ToolResultEntry,
  InstructionsEntry,
  ChecksEntry,
  NudgeEntry,
  ReferencesEntry,
  FolderListingsEntry,
  RunFailedEntry,
]);

export type EntryBody = typeof EntryBody.Type;

/** `number` starts at 1 in each session and only grows. */
export type Entry = {
  readonly session: SessionId;
  readonly number: number;
  readonly at: DateTime.Utc;
  readonly body: EntryBody;
};
