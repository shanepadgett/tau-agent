/** Reads the tool calls of a session from its entries: which calls started, which have results. */

import { Option, Predicate } from "effect";
import type { Entry, EntryBody } from "../../../session/Entry.ts";

type AssistantPart = Extract<EntryBody, { type: "assistant" }>["parts"][number];
export type ToolCall = Extract<AssistantPart, { type: "tool-call" }>;

export const resultIds = (entries: readonly Entry[]) =>
  new Set(entries.flatMap(({ body }) => (body.type === "tool-result" ? [body.callId] : [])));

export const startedIds = (entries: readonly Entry[]) =>
  new Set(entries.flatMap(({ body }) => (body.type === "tool-started" ? [body.callId] : [])));

const callsOf = (parts: readonly AssistantPart[]) =>
  parts.filter((part): part is ToolCall => part.type === "tool-call");

export const allCalls = (entries: readonly Entry[]) =>
  entries.flatMap(({ body }) => (body.type === "assistant" ? callsOf(body.parts) : []));

/**
 * The calls of the latest reply that have not started. A prompt after that reply means the user
 * moved on, so its calls stay unrun.
 */
export const openCalls = (entries: readonly Entry[]) => {
  const latest = entries.findLast(
    ({ body }) => body.type === "user" || (body.type === "assistant" && !body.interrupted),
  );

  if (latest?.body.type !== "assistant") return [];

  const handled = new Set([...resultIds(entries), ...startedIds(entries)]);
  return callsOf(latest.body.parts).filter((call) => !handled.has(call.id));
};

/**
 * The model answers next when the session ends with a prompt or a tool result. Started calls and
 * instructions saved for the next model call do not count.
 */
export const needsReply = (entries: readonly Entry[]) => {
  const last = entries.findLast(
    ({ body }) => body.type !== "tool-started" && body.type !== "instructions",
  );

  return last?.body.type === "user" || last?.body.type === "tool-result";
};

export const failedResult = (call: ToolCall, text: string): EntryBody => ({
  type: "tool-result",
  callId: call.id,
  name: call.name,
  result: text,
  isFailure: true,
});

/** The script a `run` result with entry number `scriptId` ran, if that result exists. */
export const findScript = (entries: readonly Entry[], scriptId: number) => {
  const body = entries.find((entry) => entry.number === scriptId)?.body;
  if (body?.type !== "tool-result" || body.name !== "run") return Option.none<string>();

  return Option.fromUndefinedOr(body.script);
};

/** The first line of the script, or the script it edits, so a client can show what is running. */
export const summary = (call: ToolCall) => {
  const { params } = call;

  if (Predicate.hasProperty(params, "code") && Predicate.isString(params.code))
    return params.code.trim().split("\n")[0] ?? "";

  if (Predicate.hasProperty(params, "scriptId") && Predicate.isNumber(params.scriptId))
    return `Edits to script ${params.scriptId}`;

  return call.name;
};
