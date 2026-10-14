/** Renders the messages a model sees as text, without shortening their content. Used for notes and recall. */

import type { Prompt } from "effect/ai";
import { contextView } from "./ContextView.ts";
import type { Entry } from "./Entry.ts";

export const transcript = (entries: readonly Entry[]): string =>
  promptTranscript(contextView("", entries));

export const promptTranscript = (prompt: Prompt.Prompt): string =>
  prompt.content
    .flatMap((message) => {
      const text = messageText(message);
      return text === "" ? [] : [text];
    })
    .join("\n\n");

const messageText = (message: Prompt.Message): string => {
  if (message.role === "system") return message.content === "" ? "" : `SYSTEM\n${message.content}`;

  return `${message.role.toUpperCase()}\n${message.content.map(partText).join("\n")}`;
};

const partText = (
  part: Prompt.UserMessagePart | Prompt.AssistantMessagePart | Prompt.ToolMessagePart,
): string => {
  switch (part.type) {
    case "text":
    case "reasoning":
      return part.text;
    case "tool-call":
      return `Tool call ${part.id}: ${part.name}\n${JSON.stringify(part.params)}`;
    case "tool-result":
      return `Tool result ${part.id}: ${part.name} (${part.isFailure ? "failed" : "passed"})\n${JSON.stringify(part.result)}`;
    case "file":
      return `File: ${part.mediaType}`;
    case "tool-approval-request":
      return `Tool approval: ${part.approvalId}`;
    case "tool-approval-response":
      return `Tool approval response: ${part.approvalId}`;
  }
};
