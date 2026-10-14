/** Rebuilds a checkpoint's stable memory and note prefix and its unsummarized conversation. */

import { Prompt } from "effect/ai";
import {
  conversationMessages,
  contextView,
  systemMessage,
  withCacheMark,
} from "../../../../session/ContextView.ts";
import type { CheckpointDetails, Entry, RunningProcess } from "../../../../session/Entry.ts";
import type { Memory, Note } from "../../../../session/Notes.ts";

type SavedCheckpoint = { readonly entry: Entry; readonly details: CheckpointDetails };

export const latestCheckpoint = (entries: readonly Entry[]): SavedCheckpoint | undefined => {
  const entry = entries.findLast(
    ({ body }) =>
      body.type === "tool-result" && !body.isFailure && body.details?.tool === "checkpoint",
  );

  if (entry?.body.type !== "tool-result" || entry.body.details?.tool !== "checkpoint")
    return undefined;

  return { entry, details: entry.body.details };
};

export const notesView = (
  soul: string,
  entries: readonly Entry[],
  notes: readonly Note[],
  memories: readonly Memory[],
): Prompt.Prompt => {
  const checkpoint = latestCheckpoint(entries);
  if (checkpoint === undefined) return contextView(soul, entries);

  const selected = notes.filter((note) => checkpoint.details.notes.includes(note.number));
  const memory = memories.find(({ number }) => number === checkpoint.details.memory);

  const messages: Prompt.Message[] = [...summaryPrefix(memory, selected).content];

  const lastSummary = messages.pop();
  if (lastSummary !== undefined) messages.push(withCacheMark(lastSummary));

  const instructions = entries.flatMap(({ number, body }) =>
    number < checkpoint.details.tailFrom &&
    body.type === "instructions" &&
    body.placement === "note"
      ? [body.text]
      : [],
  );

  if (instructions.length > 0) messages.push(textMessage(instructions.join("\n\n")));

  const call = entries.findLast(
    ({ body, number }) =>
      number < checkpoint.entry.number &&
      body.type === "assistant" &&
      body.parts.some(
        (part) =>
          part.type === "tool-call" &&
          checkpoint.entry.body.type === "tool-result" &&
          part.id === checkpoint.entry.body.callId,
      ),
  );

  messages.push(
    ...conversationMessages(
      entries.filter(
        (entry) =>
          entry.number >= checkpoint.details.tailFrom &&
          entry.number < (call?.number ?? checkpoint.entry.number),
      ),
    ),
  );

  messages.push(
    textMessage(
      `Your handoff at the checkpoint:\n${checkpoint.details.handoff}${runningText(checkpoint.details.processes ?? [])}\n\nCheckpoint completed. Earlier context-stage nudges no longer apply.`,
    ),
  );

  messages.push(
    ...conversationMessages(entries.filter((entry) => entry.number > checkpoint.entry.number)),
  );

  const last = messages.pop();
  if (last !== undefined) messages.push(withCacheMark(last));

  return Prompt.fromMessages([systemMessage(soul, entries), ...messages]);
};

/** The commands left running at the checkpoint, since the handoff may not name them. */
const runningText = (processes: readonly RunningProcess[]) =>
  processes.length === 0
    ? ""
    : `\n\nProcess sessions running at the checkpoint (see tools.process):\n${processes
        .map((running) => `- ${running.id}${running.pty ? " (terminal)" : ""}: ${running.command}`)
        .join("\n")}`;

const textMessage = (text: string) => Prompt.userMessage({ content: [Prompt.textPart({ text })] });

export const memoryText = (memory: Memory) =>
  `Session memory of entries 1–${memory.throughEntry}:\n${memory.text}`;

export const notesText = (notes: readonly Note[]) =>
  notes.map((note) => `Entries ${note.from}–${note.through}:\n${note.text}`).join("\n\n");

/** The memory first, then the notes after it. */
export const summaryPrefix = (memory: Memory | undefined, notes: readonly Note[]): Prompt.Prompt =>
  Prompt.fromMessages([
    ...(memory === undefined ? [] : [textMessage(memoryText(memory))]),
    ...notes.map((note) =>
      textMessage(`Notes on entries ${note.from}–${note.through}:\n${note.text}`),
    ),
  ]);
