/** The commands a client sends the agent and the events it gets back. Print mode is the first client. */

import type { ModelRef } from "../ai/Catalog.ts";
import type { Timeouts } from "./internal/run-tool/run-tool.ts";

/** How one run behaves. Each prompt carries its own, so a client can change the model between prompts. */
export type RunOptions = {
  readonly model: ModelRef;
  readonly maxTurns: number | undefined;
  readonly timeouts: Timeouts;
};

export type Command =
  | { readonly type: "prompt"; readonly text: string; readonly options: RunOptions }
  | { readonly type: "cancel" };

export type AgentEvent =
  | { readonly type: "text"; readonly delta: string }
  | { readonly type: "tool-started"; readonly callId: string; readonly summary: string }
  | { readonly type: "tool-ended"; readonly callId: string; readonly isFailure: boolean }
  /**
   * The prompts that were waiting when the user cancelled. They did not run; a client gives them
   * back to the user, such as by putting them back in the editor.
   */
  | { readonly type: "prompts-returned"; readonly prompts: readonly string[] }
  | { readonly type: "run-ended"; readonly reason: "answered" | "turn-limit" | "cancelled" }
  | { readonly type: "run-ended"; readonly reason: "failed"; readonly error: string };
