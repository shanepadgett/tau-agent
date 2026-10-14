/** Turns the saved entries of a session into the events a client shows, so a resumed chat shows its past runs. */

import type { EntryBody, Entry } from "../../../session/Entry.ts";
import type { AgentEvent } from "../../Client.ts";
import { summary } from "../loop/tool-history.ts";

type AssistantPart = Extract<EntryBody, { type: "assistant" }>["parts"][number];

export const historyEvents = (entries: readonly Entry[]): readonly AgentEvent[] =>
  entries.flatMap(({ body }) => bodyEvents(body));

const bodyEvents = (body: EntryBody): readonly AgentEvent[] => {
  switch (body.type) {
    case "user":
      return [{ type: "run-started", prompt: body.text }];
    case "assistant":
      return body.parts.flatMap(partEvents);
    case "tool-result":
      return [{ type: "tool-ended", callId: body.callId, isFailure: body.isFailure }];
    case "tool-started":
    case "checks":
    case "instructions":
    case "nudge":
      return [];
  }
};

const partEvents = (part: AssistantPart): readonly AgentEvent[] => {
  switch (part.type) {
    case "text":
      return [{ type: "text", delta: part.text }];
    case "tool-call":
      return [{ type: "tool-started", callId: part.id, name: part.name, summary: summary(part) }];
    case "reasoning":
      return [];
  }
};
