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
