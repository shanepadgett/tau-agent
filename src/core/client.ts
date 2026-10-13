/** The commands a client sends the agent and the events it gets back. Print mode is the first client. */

export type Command =
  | { readonly type: "prompt"; readonly text: string }
  | { readonly type: "cancel" };

export type RunEnd = "answered" | "cancelled" | "failed" | "turn-limit";

export type AgentEvent =
  | { readonly type: "text"; readonly delta: string }
  | { readonly type: "tool-started"; readonly callId: string; readonly summary: string }
  | { readonly type: "tool-ended"; readonly callId: string; readonly isFailure: boolean }
  | { readonly type: "run-ended"; readonly reason: RunEnd; readonly error?: string };
