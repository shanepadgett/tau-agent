/** The commands a client sends the agent and the events it gets back. Print mode is the first client. */

import type { ModelRef } from "../ai/Catalog.ts";
import { type CallTokens, clampThinking, type ThinkingLevel } from "../ai/ModelProfile.ts";
import type { ProcessSummary } from "../proc/ProcessSessions.ts";
import type { Question } from "../session/Questions.ts";
import type { Timeouts } from "./internal/run-tool/run-tool.ts";

/** How one run behaves. Each prompt carries its own, so a client can change the model between prompts. */
export type RunOptions = {
  readonly model: ModelRef;
  /** The level the user chose. Each call moves it to the nearest level its model offers. */
  readonly thinking: ThinkingLevel;
  readonly maxTurns: number | undefined;
  readonly timeouts: Timeouts;
  /** Whether the model has the `ask_question` tool on this run. Only `/qna` turns it on. */
  readonly askQuestions: boolean;
};

/** A reply's model with the level its run chose; replies saved before thinking levels have none. */
export type SavedModel = ModelRef & { readonly thinking?: ThinkingLevel | undefined };

/**
 * The level a model that offers `offered` runs at when the user chose `wanted`, for clients that
 * show it. Undefined when the model offers no levels.
 */
export const nearestThinking = (
  offered: readonly ThinkingLevel[],
  wanted: ThinkingLevel,
): ThinkingLevel | undefined => clampThinking(offered, wanted);

/**
 * `prompt` waits for the running prompt to end. `steer` reaches the running prompt at its next
 * model call; with no run going, it is a prompt.
 */
export type Command =
  | { readonly type: "prompt" | "steer"; readonly text: string; readonly options: RunOptions }
  | { readonly type: "cancel" };

/**
 * One model call of a run. `contextTokens` is the model's context limit; `cost` is in US dollars,
 * undefined when the model has no price.
 */
export type ModelCall = {
  readonly model: SavedModel;
  readonly tokens: CallTokens;
  readonly contextTokens: number;
  readonly cost: number | undefined;
};

export type AgentEvent =
  /** A prompt's run starts. Prompts sent during a run wait in order, so this tells a client which one started. */
  | { readonly type: "run-started"; readonly prompt: string }
  /** A steering message reached the running prompt, as a user entry before the next model call. */
  | { readonly type: "steered"; readonly text: string }
  | { readonly type: "text"; readonly delta: string }
  | { readonly type: "model-call-ended"; readonly call: ModelCall }
  | {
      readonly type: "tool-started";
      readonly callId: string;
      readonly name: string;
      readonly summary: string;
    }
  | { readonly type: "tool-ended"; readonly callId: string; readonly isFailure: boolean }
  /**
   * The prompts and steering messages that were waiting when the user cancelled. They did not run; a client gives them
   * back to the user, such as by putting them back in the editor.
   */
  | { readonly type: "prompts-returned"; readonly prompts: readonly string[] }
  /**
   * The model call failed with an error that can pass, such as a rate limit, and Tau calls again
   * after `seconds`. Text the client got from the failed call is not part of the answer.
   */
  | {
      readonly type: "retrying";
      readonly attempt: number;
      readonly seconds: number;
      readonly message: string;
    }
  /** Tau runs the project's checks itself, because the model ended its turn without them. */
  | { readonly type: "checks-started"; readonly checks: readonly string[] }
  | { readonly type: "checks-ended"; readonly failed: readonly string[] }
  /** The commands the agent started in process sessions changed: one started, exited or was killed. */
  | { readonly type: "processes-changed"; readonly processes: readonly ProcessSummary[] }
  /** The user attached or detached a reference repository; `names` are all the attached ones. */
  | { readonly type: "references-changed"; readonly names: readonly string[] }
  /** Background notes now cover the session's entries 1 through `through`. */
  | { readonly type: "notes-written"; readonly through: number }
  | ({ readonly type: "run-ended" } & RunEnd)
  | { readonly type: "run-ended"; readonly reason: "cancelled" }
  | { readonly type: "run-ended"; readonly reason: "failed"; readonly error: string };

/**
 * How a run ends on its own. `output-limit`: the reply stopped at the model's output limit, so the
 * answer is cut short. `repeated-call`: the model sent the same failing call again and again;
 * `call` shows what it was. `checks-failed`: the model ended its turn while the latest checks
 * of its changes failed, or they still failed after the model had its tries to fix them.
 * `questions-asked`: the model put `questions` to the user, whose answers start the next run.
 */
export type RunEnd =
  | { readonly reason: "answered" | "turn-limit" | "output-limit" }
  | { readonly reason: "repeated-call"; readonly call: string }
  | { readonly reason: "checks-failed"; readonly checks: readonly string[] }
  | { readonly reason: "questions-asked"; readonly questions: readonly Question[] };

type RunEnded = Extract<AgentEvent, { type: "run-ended" }>;

/** What to tell the user about how a run ended. An answer, or questions for the panel, need no message. */
export const runEndMessage = (end: RunEnded): string | undefined => {
  switch (end.reason) {
    case "answered":
      return undefined;
    case "cancelled":
      return "Cancelled.";
    case "failed":
      return `The run failed: ${end.error}`;
    case "turn-limit":
      return "The run reached maxTurns in ~/.tau/settings.json.";
    case "output-limit":
      return "The reply reached the model's output limit, so the answer is cut short.";
    case "repeated-call":
      return `The model sent the same failing call again and again, so Tau stopped the run: ${end.call}`;
    case "checks-failed":
      return `The run ended while the project's checks fail: ${end.checks.join(", ")}.`;
    case "questions-asked":
      return undefined;
  }
};
