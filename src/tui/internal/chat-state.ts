/**
 * The chat as data: what the agent's events and the user's sent prompts do to the items on screen.
 * Pure, so the components only draw it and the tests feed it events.
 */

import { type AgentEvent, type ModelCall, runEndMessage } from "../../core/Client.ts";

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
  | { readonly id: number; readonly kind: "notice"; readonly text: string }
  /** News that needs no action, such as when Tau restarts. */
  | { readonly id: number; readonly kind: "info"; readonly text: string };

/**
 * A prompt the user sent whose run has not started, or a steering message the run has not taken.
 * Core runs prompts in the order sent.
 */
export type QueuedPrompt = { readonly id: number; readonly text: string };

/**
 * What the session's model calls used: the context of the latest call, the model's context limit,
 * and what the calls of this chat cost in US dollars, if the model has a price.
 */
export type Usage = {
  readonly contextUsed: number;
  readonly contextTokens: number;
  readonly cost: number | undefined;
};

/** Prompts that a cancel took off the queue, for the input editor to take back. A new ID each time. */
type ReturnedPrompts = { readonly id: number; readonly prompts: readonly string[] };

export type ChatState = {
  readonly items: readonly ChatItem[];
  readonly queued: readonly QueuedPrompt[];
  readonly steering: readonly QueuedPrompt[];
  readonly usage: Usage | undefined;
  readonly returned: ReturnedPrompts | undefined;
  readonly run: RunState;
  readonly nextId: number;
};

/**
 * An agent event, a prompt or steering message the user just sent, a prompt the chat could not
 * send and why, a `/restart` that waits for the run to end, or a line a command shows.
 */
export type ChatAction =
  | AgentEvent
  | { readonly type: "prompt-sent" | "steer-sent"; readonly text: string }
  | { readonly type: "notice" | "info"; readonly text: string }
  | { readonly type: "prompt-refused"; readonly text: string; readonly reason: string }
  | { readonly type: "restart-waiting" };

type RunEnded = Extract<AgentEvent, { type: "run-ended" }>;

const EMPTY_CHAT: ChatState = {
  items: [],
  queued: [],
  steering: [],
  usage: undefined,
  returned: undefined,
  run: "idle",
  nextId: 1,
};

/** The chat of a resumed session. Its saved runs have ended, so nothing streams and no run is going. */
export const replay = (history: readonly AgentEvent[]): ChatState => {
  const state = applyActions(EMPTY_CHAT, history);
  return { ...closeStreaming(state), run: "idle" };
};

/** Idle means that no run is going and no prompt or steering message waits. */
export const isIdle = (chat: ChatState) =>
  chat.run === "idle" && chat.queued.length === 0 && chat.steering.length === 0;

/** The chat after `actions` happen in order, starting from `state`. */
export const applyActions = (state: ChatState, actions: readonly ChatAction[]): ChatState => {
  let next = state;
  for (const action of actions) next = reduce(next, action);
  return next;
};

export const reduce = (state: ChatState, action: ChatAction): ChatState => {
  switch (action.type) {
    case "prompt-sent":
      return wait(state, "queued", action.text);
    case "steer-sent":
      return wait(state, "steering", action.text);
    case "notice":
    case "info":
      return add(state, { kind: action.type, text: action.text });
    case "prompt-refused":
      return refusePrompt(state, action.text, action.reason);
    case "restart-waiting":
      return add(state, { kind: "info", text: "Tau restarts when this run ends." });
    case "run-started":
      return startRun(state, action.prompt);
    case "steered":
      return steer(state, action.text);
    case "model-call-ended":
      return { ...state, usage: addCall(state.usage, action.call) };
    case "text":
      return appendText(state, action.delta);
    case "tool-started":
      return startTool(state, action);
    case "tool-ended":
      return endTool(state, action.callId, action.isFailure ? "failed" : "ok");
    case "prompts-returned":
      return returnPrompts(state, action.prompts);
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

/** A prompt waits for the run to end, or a steering message waits for the next model call. */
const wait = (state: ChatState, list: "queued" | "steering", text: string): ChatState => ({
  ...state,
  [list]: [...state[list], { id: state.nextId, text }],
  nextId: state.nextId + 1,
});

/** The model read a steering message, so it moves from the waiting list into the transcript. */
const steer = (state: ChatState, text: string): ChatState =>
  add(
    { ...closeStreaming(state), steering: withoutFirst(state.steering, text) },
    { kind: "user", text },
  );

const startTool = (
  state: ChatState,
  { callId, name, summary }: Extract<AgentEvent, { type: "tool-started" }>,
): ChatState =>
  add(
    { ...closeStreaming(state), run: "running" },
    {
      kind: "tool",
      callId,
      name,
      summary,
      status: "running",
    },
  );

/** Every waiting prompt and steering message goes back to the editor. */
const returnPrompts = (state: ChatState, prompts: readonly string[]): ChatState => ({
  ...state,
  queued: [],
  steering: [],
  returned: { id: state.nextId, prompts },
  nextId: state.nextId + 1,
});

/** The prompt goes back to the editor, and the transcript says why. */
const refusePrompt = (state: ChatState, text: string, reason: string): ChatState =>
  add(
    { ...state, returned: { id: state.nextId, prompts: [text] }, nextId: state.nextId + 1 },
    { kind: "notice", text: reason },
  );

/**
 * The first queued prompt with this text leaves the queue. A steering message that reached no model
 * call runs as a prompt, so it leaves the steering list. A prompt from history was never queued.
 */
const startRun = (state: ChatState, prompt: string): ChatState => {
  const queued = withoutFirst(state.queued, prompt);

  const steering =
    queued.length === state.queued.length ? withoutFirst(state.steering, prompt) : state.steering;

  return add(
    { ...closeStreaming(state), queued, steering, run: "running" },
    { kind: "user", text: prompt },
  );
};

const withoutFirst = (waiting: readonly QueuedPrompt[], text: string) => {
  const index = waiting.findIndex((queued) => queued.text === text);
  return index === -1 ? waiting : waiting.toSpliced(index, 1);
};

/** The context is what the latest call sent and got back; the cost adds up over the calls. */
const addCall = (usage: Usage | undefined, call: ModelCall): Usage => ({
  contextUsed: (call.tokens.input ?? 0) + (call.tokens.output ?? 0),
  contextTokens: call.contextTokens,
  cost: call.cost === undefined ? usage?.cost : (usage?.cost ?? 0) + call.cost,
});

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
