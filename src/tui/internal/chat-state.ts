/**
 * The chat as data: what the agent's events and the user's sent prompts do to the items on screen.
 * Pure, so the components only draw it and the tests feed it events.
 */

import { type AgentEvent, runEndMessage } from "../../core/Client.ts";

type RunState = "idle" | "running" | "retrying";

export type ChatItem =
  | { readonly id: number; readonly kind: "user"; readonly text: string }
  | {
      readonly id: number;
      readonly kind: "assistant";
      readonly text: string;
      readonly streaming: boolean;
    }
  | {
      readonly id: number;
      readonly kind: "tool";
      readonly callId: string;
      readonly name: string;
      readonly summary: string;
      readonly status: "running" | "ok" | "failed";
    }
  | { readonly id: number; readonly kind: "notice"; readonly text: string };

/** A prompt the user sent whose run has not started. Core runs prompts in the order sent. */
export type QueuedPrompt = { readonly id: number; readonly text: string };

/** Prompts that a cancel took off the queue, for the input editor to take back. A new ID each time. */
type ReturnedPrompts = { readonly id: number; readonly prompts: readonly string[] };

export type ChatState = {
  readonly items: readonly ChatItem[];
  readonly queued: readonly QueuedPrompt[];
  readonly returned: ReturnedPrompts | undefined;
  readonly run: RunState;
  /** What the supervisor last said about new code, for the line under the input. */
  readonly restartNotice: string | undefined;
  readonly nextId: number;
};

/**
 * An agent event, a prompt the user just sent, a prompt the chat could not send and why, or news
 * about a restart into new code.
 */
export type ChatAction =
  | AgentEvent
  | { readonly type: "prompt-sent"; readonly text: string }
  | { readonly type: "prompt-refused"; readonly text: string; readonly reason: string }
  | { readonly type: "restart-notice"; readonly text: string };

type RunEnded = Extract<AgentEvent, { type: "run-ended" }>;

const EMPTY_CHAT: ChatState = {
  items: [],
  queued: [],
  returned: undefined,
  run: "idle",
  restartNotice: undefined,
  nextId: 1,
};

/** The chat of a resumed session. Its saved runs have ended, so nothing streams and no run is going. */
export const replay = (history: readonly AgentEvent[]): ChatState => {
  const state = applyActions(EMPTY_CHAT, history);
  return { ...closeStreaming(state), run: "idle" };
};

/** The chat after `actions` happen in order, starting from `state`. */
export const applyActions = (state: ChatState, actions: readonly ChatAction[]): ChatState => {
  let next = state;
  for (const action of actions) next = reduce(next, action);
  return next;
};

export const reduce = (state: ChatState, action: ChatAction): ChatState => {
  switch (action.type) {
    case "prompt-sent":
      return {
        ...state,
        queued: [...state.queued, { id: state.nextId, text: action.text }],
        nextId: state.nextId + 1,
      };
    case "prompt-refused":
      return refusePrompt(state, action.text, action.reason);
    case "restart-notice":
      return { ...state, restartNotice: action.text };
    case "run-started":
      return startRun(state, action.prompt);
    case "text":
      return appendText(state, action.delta);
    case "tool-started":
      return add(
        { ...closeStreaming(state), run: "running" },
        {
          kind: "tool",
          callId: action.callId,
          name: action.name,
          summary: action.summary,
          status: "running",
        },
      );
    case "tool-ended":
      return endTool(state, action.callId, action.isFailure ? "failed" : "ok");
    case "prompts-returned":
      return {
        ...state,
        queued: [],
        returned: { id: state.nextId, prompts: action.prompts },
        nextId: state.nextId + 1,
      };
    case "retrying":
      return add(
        { ...dropStreaming(state), run: "retrying" },
        {
          kind: "notice",
          text: `Retry ${action.attempt} in ${action.seconds} s: ${action.message}`,
        },
      );
    case "checks-started":
      return add(state, {
        kind: "notice",
        text: `Running the project's checks: ${action.checks.join(", ")}`,
      });
    case "checks-ended":
      return add(state, { kind: "notice", text: checksText(action.failed) });
    case "run-ended":
      return endRun(state, action);
  }
};

const add = (state: ChatState, item: DistributiveOmit<ChatItem, "id">): ChatState => ({
  ...state,
  items: [...state.items, { ...item, id: state.nextId }],
  nextId: state.nextId + 1,
});

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** The prompt goes back to the editor, and the transcript says why. */
const refusePrompt = (state: ChatState, text: string, reason: string): ChatState =>
  add(
    { ...state, returned: { id: state.nextId, prompts: [text] }, nextId: state.nextId + 1 },
    { kind: "notice", text: reason },
  );

/** The first queued prompt with this text leaves the queue; a prompt from history was never queued. */
const startRun = (state: ChatState, prompt: string): ChatState => {
  const index = state.queued.findIndex((queued) => queued.text === prompt);
  const queued = index === -1 ? state.queued : state.queued.toSpliced(index, 1);
  return add({ ...closeStreaming(state), queued, run: "running" }, { kind: "user", text: prompt });
};

const appendText = (state: ChatState, delta: string): ChatState => {
  const last = state.items.at(-1);

  if (last?.kind === "assistant" && last.streaming) {
    const items = [...state.items.slice(0, -1), { ...last, text: last.text + delta }];
    return { ...state, items, run: "running" };
  }

  return add({ ...state, run: "running" }, { kind: "assistant", text: delta, streaming: true });
};

const endTool = (state: ChatState, callId: string, status: "ok" | "failed"): ChatState => ({
  ...state,
  items: state.items.map((item) =>
    item.kind === "tool" && item.callId === callId ? { ...item, status } : item,
  ),
});

const closeStreaming = (state: ChatState): ChatState => ({
  ...state,
  items: state.items.map((item) =>
    item.kind === "assistant" && item.streaming ? { ...item, streaming: false } : item,
  ),
});

/** The text of a model call that failed is not part of the answer. */
const dropStreaming = (state: ChatState): ChatState => ({
  ...state,
  items: state.items.filter((item) => item.kind !== "assistant" || !item.streaming),
});

const endRun = (state: ChatState, end: RunEnded): ChatState => {
  const ended = { ...closeStreaming(state), run: "idle" as const };
  const text = runEndMessage(end);
  return text === undefined ? ended : add(ended, { kind: "notice", text });
};

const checksText = (failed: readonly string[]) =>
  failed.length === 0 ? "The checks pass." : `These checks fail: ${failed.join(", ")}.`;
