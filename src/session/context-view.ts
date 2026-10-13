/**
 * Builds what the model sees from a session's entries. It is the one place that turns Tau's
 * entries into Effect's prompt types.
 */

import { Prompt } from "effect/ai";
import type { Entry, EntryBody } from "./entry.ts";

type AssistantEntry = Extract<EntryBody, { type: "assistant" }>;
type AssistantPart = AssistantEntry["parts"][number];
type ToolCall = Extract<AssistantPart, { type: "tool-call" }>;
type ToolResult = Extract<EntryBody, { type: "tool-result" }>;

/** The result a call gets when no result was saved for it. */
const MISSING_RESULT = "The call ended before it returned a result.";

/**
 * Repairs the tool history while it converts, because the protocols refuse a call without a
 * result: each call gets its result right after the reply that made it, a call without a saved
 * result (a cancel, a crash, a branch cut) gets an error result, and a result without a call is
 * left out. Interrupted replies are left out too.
 */
export const contextView = (entries: readonly Entry[]): Prompt.Prompt => {
  const savedResults = new Map<string, ToolResult>();

  for (const { body } of entries) {
    if (body.type === "tool-result" && !savedResults.has(body.callId))
      savedResults.set(body.callId, body);
  }

  const messages: Prompt.Message[] = [];

  for (const { body } of entries) {
    if (body.type === "user") {
      messages.push(Prompt.userMessage({ content: [Prompt.textPart({ text: body.text })] }));
    }

    if (body.type === "assistant" && !body.interrupted) {
      messages.push(...replyMessages(body, savedResults));
    }
  }

  return Prompt.fromMessages(messages);
};

const replyMessages = (reply: AssistantEntry, savedResults: ReadonlyMap<string, ToolResult>) => {
  const assistant = Prompt.assistantMessage({ content: reply.parts.map(assistantPart) });
  const calls = reply.parts.filter((part): part is ToolCall => part.type === "tool-call");
  if (calls.length === 0) return [assistant];

  const content = calls.map((call) => toolResultPart(call, savedResults.get(call.id)));
  return [assistant, Prompt.toolMessage({ content })];
};

const assistantPart = (part: AssistantPart) => {
  switch (part.type) {
    case "text":
      return Prompt.textPart({ text: part.text, options: part.providerData });
    case "reasoning":
      return Prompt.reasoningPart({ text: part.text, options: part.providerData });
    case "tool-call":
      return Prompt.toolCallPart({
        id: part.id,
        name: part.name,
        params: part.params,
        providerExecuted: false,
        options: part.providerData,
      });
  }
};

const toolResultPart = (call: ToolCall, saved: ToolResult | undefined) =>
  Prompt.toolResultPart({
    id: call.id,
    name: call.name,
    result: saved?.result ?? MISSING_RESULT,
    isFailure: saved?.isFailure ?? true,
    providerExecuted: false,
  });
