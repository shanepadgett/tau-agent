/**
 * A table of events and the chat they give. A unit test because the reducer has many input cases;
 * the flow test in `tests/tui/` can show only a few of them on screen.
 */

import { expect, test } from "bun:test";
import { applyActions, type ChatAction, type ChatState, replay } from "./chat-state.ts";

const chatAfter = (actions: readonly ChatAction[]): ChatState => applyActions(replay([]), actions);

const RUNNING: readonly ChatAction[] = [
  { type: "prompt-sent", text: "Hi." },
  { type: "run-started", prompt: "Hi." },
];

const SLEEP = { id: "p1", command: "sleep 30", pty: false, state: { type: "running" } } as const;

const cases: ReadonlyArray<readonly [string, readonly ChatAction[], Partial<ChatState>]> = [
  [
    "the newest process list replaces the one before",
    [
      { type: "processes-changed", processes: [SLEEP] },
      { type: "processes-changed", processes: [{ ...SLEEP, state: { type: "killed" } }] },
    ],
    { processes: [{ ...SLEEP, state: { type: "killed" } }], items: [] },
  ],
  [
    "written notes move how far the notes reach",
    [
      { type: "notes-written", through: 40 },
      { type: "notes-written", through: 86 },
    ],
    { notesThrough: 86, items: [] },
  ],
  [
    "a sent prompt waits in the queue",
    [{ type: "prompt-sent", text: "Hi." }],
    { queued: [{ id: 1, text: "Hi." }], items: [] },
  ],
  [
    "a prompt the chat cannot send goes back to the editor with the reason",
    [{ type: "prompt-refused", text: "Hi.", reason: "No model is set." }],
    {
      queued: [],
      returned: { id: 1, prompts: ["Hi."] },
      items: [{ id: 2, kind: "notice", text: "No model is set." }],
    },
  ],
  [
    "a started run takes its prompt off the queue",
    RUNNING,
    { queued: [], run: "running", items: [{ id: 2, kind: "user", text: "Hi." }] },
  ],
  [
    "text deltas join into one streaming answer",
    [...RUNNING, { type: "text", delta: "Hel" }, { type: "text", delta: "lo." }],
    {
      items: [
        { id: 2, kind: "user", text: "Hi." },
        { id: 3, kind: "assistant", text: "Hello.", streaming: true },
      ],
    },
  ],
  [
    "a tool call ends the streaming answer and shows its result",
    [
      ...RUNNING,
      { type: "text", delta: "Let me look." },
      { type: "tool-started", callId: "c1", name: "run", summary: "ls" },
      { type: "tool-ended", callId: "c1", isFailure: true },
    ],
    {
      items: [
        { id: 2, kind: "user", text: "Hi." },
        { id: 3, kind: "assistant", text: "Let me look.", streaming: false },
        { id: 4, kind: "tool", callId: "c1", name: "run", summary: "ls", status: "failed" },
      ],
    },
  ],
  [
    "a retry drops the text of the failed call",
    [
      ...RUNNING,
      { type: "text", delta: "Half" },
      { type: "retrying", attempt: 1, seconds: 2, message: "Rate limit." },
    ],
    {
      run: "retrying",
      items: [
        { id: 2, kind: "user", text: "Hi." },
        { id: 4, kind: "notice", text: "Retry 1 in 2 s: Rate limit." },
      ],
    },
  ],
  [
    "a cancel gives the queued prompts back",
    [
      ...RUNNING,
      { type: "prompt-sent", text: "Next." },
      { type: "prompts-returned", prompts: ["Next."] },
    ],
    { queued: [], returned: { id: 4, prompts: ["Next."] } },
  ],
  [
    "a run that ends with a reason other than an answer adds a notice",
    [...RUNNING, { type: "run-ended", reason: "cancelled" }],
    {
      run: "idle",
      items: [
        { id: 2, kind: "user", text: "Hi." },
        { id: 3, kind: "notice", text: "Cancelled." },
      ],
    },
  ],
  [
    "checks show what runs and what fails",
    [
      { type: "checks-started", checks: ["lint"] },
      { type: "checks-ended", failed: ["lint"] },
    ],
    {
      items: [
        { id: 1, kind: "notice", text: "Running the project's checks: lint" },
        { id: 2, kind: "notice", text: "These checks fail: lint." },
      ],
    },
  ],
  [
    "a steering message waits until the run takes it, then shows as the user's",
    [
      ...RUNNING,
      { type: "text", delta: "Working." },
      { type: "steer-sent", text: "Use Python." },
      { type: "steered", text: "Use Python." },
    ],
    {
      steering: [],
      run: "running",
      items: [
        { id: 2, kind: "user", text: "Hi." },
        { id: 3, kind: "assistant", text: "Working.", streaming: false },
        { id: 5, kind: "user", text: "Use Python." },
      ],
    },
  ],
  [
    "a steering message that reached no model call runs as the next prompt",
    [
      ...RUNNING,
      { type: "steer-sent", text: "And test it." },
      { type: "run-ended", reason: "answered" },
      { type: "run-started", prompt: "And test it." },
    ],
    { steering: [], run: "running" },
  ],
];

test.each(cases)("%s", (_name, actions, expected) => {
  expect(chatAfter(actions)).toMatchObject(expected);
});

test("a replayed history has no streaming answer and no run going", () => {
  const chat = replay([
    { type: "run-started", prompt: "Hi." },
    { type: "text", delta: "Hello." },
  ]);

  expect(chat.run).toBe("idle");
  expect(chat.items.at(-1)).toEqual({ id: 2, kind: "assistant", text: "Hello.", streaming: false });
});
