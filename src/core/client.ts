/** The commands a client sends the agent and the events it gets back. Print mode is the first client. */

import type { ModelRef } from "../ai/Catalog.ts";
import { type CallTokens, clampThinking, type ThinkingLevel } from "../ai/ModelProfile.ts";
import type { Timeouts } from "./internal/run-tool/run-tool.ts";

/** How one run behaves. Each prompt carries its own, so a client can change the model between prompts. */
export type RunOptions = {
  readonly model: ModelRef;
  /** The level the user chose. Each call moves it to the nearest level its model offers. */
  readonly thinking: ThinkingLevel;
  readonly maxTurns: number | undefined;
  readonly timeouts: Timeouts;
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
  | ({ readonly type: "run-ended" } & RunEnd)
  | { readonly type: "run-ended"; readonly reason: "cancelled" }
  | { readonly type: "run-ended"; readonly reason: "failed"; readonly error: string };

/**
 * How a run ends on its own. `output-limit`: the reply stopped at the model's output limit, so the
 * answer is cut short. `repeated-call`: the model sent the same failing call again and again;
 * `call` shows what it was. `checks-failed`: the checks Tau ran itself still failed after the
 * model had its tries to fix them.
 */
export type RunEnd =
  | { readonly reason: "answered" | "turn-limit" | "output-limit" }
  | { readonly reason: "repeated-call"; readonly call: string }
  | { readonly reason: "checks-failed"; readonly checks: readonly string[] };

type RunEnded = Extract<AgentEvent, { type: "run-ended" }>;

/** What to tell the user about how a run ended. An answer needs no message. */
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
      return `The project's checks still fail after the model's tries to fix them: ${end.checks.join(", ")}.`;
  }
};
