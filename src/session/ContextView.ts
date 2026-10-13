/**
 * Builds what the model sees from a session's entries. It is the one place that turns Tau's
 * entries into Effect's prompt types.
 */

import { Predicate } from "effect";
import { Prompt } from "effect/ai";
import type { Entry, EntryBody } from "./Entry.ts";

type AssistantEntry = Extract<EntryBody, { type: "assistant" }>;
type AssistantPart = AssistantEntry["parts"][number];
type ToolCall = Extract<AssistantPart, { type: "tool-call" }>;
type ToolResult = Extract<EntryBody, { type: "tool-result" }>;
type SavedResult = { readonly number: number; readonly body: ToolResult };

/**
 * Claude caches a request only up to the parts it marks. The mark on the system prompt keeps the
 * shared start cached; the mark on the last message caches the whole conversation for the next
 * request. Effect's Anthropic and OpenRouter providers read these keys; others ignore them.
 */
const CACHE_MARK = {
  anthropic: { cacheControl: { type: "ephemeral" } },
  openrouter: { cacheControl: { type: "ephemeral" } },
} as const;

/** The result a call gets when no result was saved for it. */
const MISSING_RESULT = "The call ended before it returned a result.";

/**
 * Gives the system prompt and the conversation of `entries`, with cache marks. The system prompt is
 * `soul` and the newest instructions for the system prompt; later instructions are notes at their
 * place in the chat. Repairs
 * the tool history while it converts, because the protocols refuse a call without a
 * result: each call gets its result right after the reply that made it, a call without a saved
 * result (a cancel, a crash, a branch cut) gets an error result, and a result without a call is
 * left out. Interrupted replies are left out too. A failed script's result ends with its script ID.
 */
export const contextView = (soul: string, entries: readonly Entry[]): Prompt.Prompt => {
  const savedResults = new Map<string, SavedResult>();

  for (const { number, body } of entries) {
    if (body.type === "tool-result" && !savedResults.has(body.callId))
      savedResults.set(body.callId, { number, body });
  }

  const messages: Prompt.Message[] = [];

  for (const { body } of entries) {
    if (body.type === "user") {
      messages.push(Prompt.userMessage({ content: [Prompt.textPart({ text: body.text })] }));
    }

    if (body.type === "assistant" && !body.interrupted) {
      messages.push(...replyMessages(body, savedResults));
    }

    if (body.type === "instructions" && body.placement === "note") {
      messages.push(Prompt.userMessage({ content: [Prompt.textPart({ text: body.text })] }));
    }
  }

  const instructions = entries.findLast(
    ({ body }) => body.type === "instructions" && body.placement === "system",
  );

  const system =
    instructions?.body.type === "instructions" ? `${soul}\n\n${instructions.body.text}` : soul;

  const last = messages.pop();
  if (last !== undefined) messages.push(withCacheMark(last));

  return Prompt.fromMessages([
    Prompt.systemMessage({ content: system, options: CACHE_MARK }),
    ...messages,
  ]);
};

const withCacheMark = (message: Prompt.Message): Prompt.Message => {
  switch (message.role) {
    case "system":
      return Prompt.systemMessage({ content: message.content, options: CACHE_MARK });
    case "user":
      return Prompt.userMessage({ content: message.content, options: CACHE_MARK });
    case "assistant":
      return Prompt.assistantMessage({ content: message.content, options: CACHE_MARK });
    case "tool":
      return Prompt.toolMessage({ content: message.content, options: CACHE_MARK });
  }
};

const replyMessages = (reply: AssistantEntry, savedResults: ReadonlyMap<string, SavedResult>) => {
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

const toolResultPart = (call: ToolCall, saved: SavedResult | undefined) =>
  Prompt.toolResultPart({
    id: call.id,
    name: call.name,
    result: saved === undefined ? MISSING_RESULT : modelResult(saved),
    isFailure: saved?.body.isFailure ?? true,
    providerExecuted: false,
  });

/**
 * The script ID is the number of the result's entry, so the model can fix the script with edits.
 * It is added here and not saved, because an entry gets its number only when it is saved.
 */
const modelResult = ({ number, body }: SavedResult) => {
  const isFailedScript =
    body.isFailure && body.script !== undefined && Predicate.isString(body.result);

  return isFailedScript ? `${String(body.result)}\n\nScript ID: ${number}` : body.result;
};
