/** Computes context budgets and estimates growth between provider token reports. */

import type { ModelProfile } from "../../../../ai/ModelProfile.ts";
import type { Prompt } from "effect/ai";
import type { Entry } from "../../../../session/Entry.ts";
import { promptTranscript, transcript } from "../../../../session/transcript.ts";
import type { CompactionSettings } from "../../../ContextSettings.ts";
import { latestCheckpoint, notesView } from "./view.ts";

const RESERVE_TOKENS = 16_000;
const DEFAULT_BUDGET_TOKENS = 200_000;
export const DEFAULT_NOTES_START_TOKENS = 50_000;
const CHARACTERS_PER_TOKEN = 4;
const NOTICE_FRACTION = 0.5;
const WARNING_FRACTION = 0.75;

type ContextStage = "none" | "notice" | "warning" | "forced";

export const contextBudget = (profile: ModelProfile, settings: CompactionSettings) =>
  Math.min(
    Math.max(1, profile.contextTokens - RESERVE_TOKENS),
    profile.longContextPrice?.aboveTokens ?? Infinity,
    settings.budgetTokens ?? DEFAULT_BUDGET_TOKENS,
  );

export const estimatedTokens = (entries: readonly Entry[]) =>
  Math.ceil(transcript(entries).length / CHARACTERS_PER_TOKEN);

export const estimatedPromptTokens = (prompt: Prompt.Prompt) =>
  Math.ceil(promptTranscript(prompt).length / CHARACTERS_PER_TOKEN);

export const contextSize = (entries: readonly Entry[]) => {
  const checkpoint = latestCheckpoint(entries);
  const recent = entries.filter((entry) => entry.number > (checkpoint?.entry.number ?? 0));

  const reply = recent.findLast(
    ({ body }) =>
      body.type === "assistant" && !body.interrupted && body.tokens?.input !== undefined,
  );

  if (reply?.body.type === "assistant") {
    // `input` is the total, including cache reads and writes.
    const measured = (reply.body.tokens?.input ?? 0) + (reply.body.tokens?.output ?? 0);
    const later = recent.filter((entry) => entry.number > reply.number);
    // Keep the call beside its later results; the message builder drops orphan results.
    const growth = estimatedTokens([reply, ...later]) - estimatedTokens([reply]);
    return measured + Math.max(0, growth);
  }

  if (checkpoint === undefined) return estimatedTokens(entries);
  // The pinned note estimate is saved with the checkpoint so loop operations need only entries.
  return estimatedPromptTokens(notesView("", entries, [], [])) + checkpoint.details.noteTokens;
};

export const contextStage = (entries: readonly Entry[], budgetTokens: number): ContextStage => {
  const size = contextSize(entries);
  const checkpoint = latestCheckpoint(entries);

  const stages = [
    { name: "forced", fraction: 1 },
    { name: "warning", fraction: WARNING_FRACTION },
    { name: "notice", fraction: NOTICE_FRACTION },
  ] as const;

  // Provider reports can lower an estimate; an announced stage lasts until the checkpoint.
  for (const stage of stages) {
    const announced = entries.some(
      ({ number, body }) =>
        number > (checkpoint?.entry.number ?? 0) &&
        body.type === "nudge" &&
        body.key === `context-stage:${stage.name}`,
    );

    if (announced || size >= budgetTokens * stage.fraction) return stage.name;
  }

  return "none";
};
