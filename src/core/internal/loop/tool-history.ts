/** Reads the tool calls of a session from its entries: which calls started, which have results. */

import { Predicate } from "effect";
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

/** The model answers next when the session ends with a prompt or a tool result. */
export const needsReply = (entries: readonly Entry[]) => {
  const last = entries.findLast(({ body }) => body.type !== "tool-started");
  return last?.body.type === "user" || last?.body.type === "tool-result";
};

export const failedResult = (call: ToolCall, text: string): EntryBody => ({
  type: "tool-result",
  callId: call.id,
  name: call.name,
  result: text,
  isFailure: true,
});

/** The first line of the script, so a client can show what is running. */
export const summary = (call: ToolCall) => {
  const code = Predicate.hasProperty(call.params, "code") ? call.params.code : undefined;
  return Predicate.isString(code) ? (code.trim().split("\n")[0] ?? "") : call.name;
};
