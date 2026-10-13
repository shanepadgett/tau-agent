/**
 * Builds what the model sees from a session's entries. It is the one place that turns Tau's
 * entries into Effect's prompt types.
 */

import { Prompt } from "effect/ai";
import type { Entry, EntryBody } from "./entry.ts";

type AssistantPart = Extract<EntryBody, { type: "assistant" }>["parts"][number];
type ToolResult = Extract<EntryBody, { type: "tool-result" }>;

export const contextView = (entries: readonly Entry[]): Prompt.Prompt => {
  const messages: Prompt.Message[] = [];

  for (const { body } of entries) {
    const previous = messages.at(-1);

    // Consecutive tool results become one tool message, as the protocols expect.
    if (body.type === "tool-result" && previous?.role === "tool") {
      const content = [...previous.content, toolResultPart(body)];
      messages[messages.length - 1] = Prompt.toolMessage({ content });
    } else {
      messages.push(message(body));
    }
  }

  return Prompt.fromMessages(messages);
};

const message = (body: EntryBody): Prompt.Message => {
  switch (body.type) {
    case "user":
      return Prompt.userMessage({ content: [Prompt.textPart({ text: body.text })] });
    case "assistant":
      return Prompt.assistantMessage({ content: body.parts.map(assistantPart) });
    case "tool-result":
      return Prompt.toolMessage({ content: [toolResultPart(body)] });
  }
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

const toolResultPart = (body: ToolResult) =>
  Prompt.toolResultPart({
    id: body.callId,
    name: body.name,
    result: body.result,
    isFailure: body.isFailure,
    providerExecuted: false,
  });
