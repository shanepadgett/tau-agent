/**
 * Checks the restart decisions: when the supervisor builds, checks and switches, and how it falls
 * back after crashes.
 */

import { expect, test } from "bun:test";
import type { Build } from "../Builds.ts";
import type { ReloadCondition } from "../Messages.ts";
import {
  type RestartCommand,
  type RestartEvent,
  type RestartMode,
  type RestartState,
  reloadConditions,
  startingState,
  transition,
} from "./restart-machine.ts";

const FIRST: Build = { id: 1, command: ["tau"] };
const SECOND: Build = { id: 2, command: ["tau"] };
const LATE = 60_000;
const EARLY = 1000;

const ready = (session: string): RestartEvent => ({
  type: "message",
  message: { type: "ready", session },
});

const IDLE: RestartEvent = { type: "message", message: { type: "idle", idle: true } };
const WORKING: RestartEvent = { type: "message", message: { type: "idle", idle: false } };
const RESTART_REQUEST: RestartEvent = { type: "message", message: { type: "restart-request" } };

const HANDOFF: RestartEvent = {
  type: "message",
  message: { type: "handoff", session: "s1", draft: "unsent" },
};

const ATTENTION: RestartEvent = {
  type: "message",
  message: { type: "attention", message: "Response ready" },
};

const DELIVER: RestartCommand = {
  type: "send",
  message: { type: "deliver-attention", message: "Response ready" },
};

const crashed = (ranMillis: number): RestartEvent => ({ type: "exited", code: 1, ranMillis });
const QUIT: RestartEvent = { type: "exited", code: 0, ranMillis: LATE };
const CHANGED: RestartEvent = { type: "source-changed" };

const LOGGED: Partial<RestartCommand> = { type: "log" };

const FAILED: RestartEvent = {
  type: "failed",
  reason: "The new code does not build: x.ts:1\nmore",
};

/** The conditions the supervisor sends, with only the fields a case checks. */
type ConditionsSent = {
  readonly type: "send";
  readonly message: {
    readonly type: "conditions";
    readonly conditions: readonly Partial<ReloadCondition>[];
  };
};

/** The conditions the supervisor sends; each one is matched by its key and severity. */
const conditions = (
  ...expected: readonly (readonly [string, ReloadCondition["severity"]])[]
): ConditionsSent => ({
  type: "send",
  message: {
    type: "conditions",
    conditions: expected.map(([key, severity]) => ({ key, severity })),
  },
});

const NONE = conditions();
const FAILURE = conditions(["reload.code", "warning"]);
const FALLBACK = conditions(["reload.fallback", "error"]);
const EXIT: RestartCommand = { type: "send", message: { type: "exit-for-restart" } };

/** The open chat of session `s1` on the first build, idle or busy. */
const OPEN = [ready("s1"), IDLE];
const BUSY = [ready("s1"), WORKING];

/** New code that builds and passes its check. */
const NEW_CODE: readonly RestartEvent[] = [
  CHANGED,
  { type: "built", build: SECOND },
  { type: "checked", build: SECOND },
];

const SWITCHED = [...OPEN, ...NEW_CODE, HANDOFF, QUIT];

/** The state after each event in turn, and every command on the way. */
const afterEvents = (events: readonly RestartEvent[], mode: RestartMode) => {
  let state: RestartState = startingState(FIRST, mode);
  const commands: RestartCommand[] = [];

  for (const event of events) {
    const step = transition(state, event);
    state = step.state;
    commands.push(...step.commands);
  }

  return { state, commands };
};

/** The parts of the state and the commands that a case expects. */
type Case = {
  readonly name: string;
  readonly mode: RestartMode;
  readonly events: readonly RestartEvent[];
  readonly state: Partial<Omit<RestartState, "phase">> & {
    readonly phase?: Partial<RestartState["phase"]>;
  };
  readonly commands: readonly (Partial<RestartCommand> | ConditionsSent)[];
};

const cases: Case[] = [
  {
    name: "a change builds the new code",
    mode: "automatic",
    events: [...OPEN, CHANGED],
    state: { phase: { kind: "building" } },
    commands: [{ type: "build" }],
  },
  {
    name: "a new build gets its start check",
    mode: "automatic",
    events: [...OPEN, CHANGED, { type: "built", build: SECOND }],
    state: { phase: { kind: "checking" } },
    commands: [{ type: "build" }, { type: "check", build: SECOND }],
  },
  {
    name: "checked code waits while a run goes",
    mode: "automatic",
    events: [...BUSY, ...NEW_CODE],
    state: { phase: { kind: "ready", candidate: SECOND } },
    commands: [{ type: "build" }, { type: "check" }],
  },
  {
    name: "checked code takes over as soon as the chat is idle",
    mode: "automatic",
    events: [...BUSY, ...NEW_CODE, IDLE],
    state: { phase: { kind: "handing-over", next: SECOND } },
    commands: [{ type: "build" }, { type: "check" }, EXIT],
  },
  {
    name: "without autoRestart, checked code waits for /restart and says so",
    mode: "manual",
    events: [...OPEN, ...NEW_CODE],
    state: { phase: { kind: "ready" } },
    commands: [{ type: "build" }, { type: "check" }, conditions(["reload.code", "info"])],
  },
  {
    name: "/restart switches to checked code",
    mode: "manual",
    events: [...OPEN, ...NEW_CODE, RESTART_REQUEST],
    state: { phase: { kind: "handing-over", next: SECOND } },
    commands: [
      { type: "build" },
      { type: "check" },
      conditions(["reload.code", "info"]),
      EXIT,
      NONE,
    ],
  },
  {
    name: "/restart without new code restarts the same build",
    mode: "manual",
    events: [...OPEN, RESTART_REQUEST, HANDOFF, QUIT],
    state: { phase: { kind: "running" }, current: FIRST, lastGood: undefined },
    commands: [
      EXIT,
      { type: "start", build: FIRST, session: "s1", draft: "unsent" },
      { type: "prune", keep: [FIRST] },
    ],
  },
  {
    name: "after the handoff the new build starts with the session and the unsent input",
    mode: "automatic",
    events: SWITCHED,
    state: { phase: { kind: "running" }, current: SECOND, lastGood: FIRST },
    commands: [
      { type: "build" },
      { type: "check" },
      EXIT,
      { type: "start", build: SECOND, session: "s1", draft: "unsent" },
      { type: "prune", keep: [SECOND, FIRST] },
    ],
  },
  {
    name: "a change during a build builds again",
    mode: "automatic",
    events: [...BUSY, CHANGED, CHANGED, { type: "built", build: SECOND }],
    state: { phase: { kind: "building", changedAgain: false } },
    commands: [{ type: "build" }, { type: "build" }],
  },
  {
    name: "a failed build keeps the chat and sends the reason as a condition",
    mode: "automatic",
    events: [...OPEN, CHANGED, FAILED],
    state: { phase: { kind: "running" } },
    commands: [{ type: "build" }, FAILURE],
  },
  {
    name: "new code that passes its check after a failure is ready, and clears the failure",
    mode: "automatic",
    events: [...BUSY, CHANGED, FAILED, ...NEW_CODE],
    state: { phase: { kind: "ready", candidate: SECOND } },
    commands: [{ type: "build" }, FAILURE, { type: "build" }, { type: "check" }, NONE],
  },
  {
    name: "attention with no new code goes back to the chat at once",
    mode: "automatic",
    events: [...OPEN, ATTENTION],
    state: { attention: undefined },
    commands: [DELIVER],
  },
  {
    name: "attention waits while new code builds",
    mode: "automatic",
    events: [...OPEN, CHANGED, ATTENTION],
    state: { attention: "Response ready", phase: { kind: "building" } },
    commands: [{ type: "build" }],
  },
  {
    name: "attention held through a build goes to the new chat when it starts",
    mode: "automatic",
    events: [
      ...BUSY,
      CHANGED,
      ATTENTION,
      IDLE,
      { type: "built", build: SECOND },
      { type: "checked", build: SECOND },
      HANDOFF,
      QUIT,
    ],
    state: { attention: undefined, phase: { kind: "running" }, current: SECOND },
    commands: [
      { type: "build" },
      { type: "check" },
      EXIT,
      { type: "start", build: SECOND, attention: "Response ready" },
      { type: "prune" },
    ],
  },
  {
    name: "attention sent just after the chat is told to exit goes to the new chat",
    mode: "automatic",
    events: [...BUSY, ...NEW_CODE, IDLE, ATTENTION, HANDOFF, QUIT],
    state: { attention: undefined, current: SECOND },
    commands: [
      { type: "build" },
      { type: "check" },
      EXIT,
      { type: "start", build: SECOND, attention: "Response ready" },
      { type: "prune" },
    ],
  },
  {
    name: "attention held while the code changes again waits for the latest build",
    mode: "automatic",
    events: [...BUSY, CHANGED, ATTENTION, CHANGED, { type: "built", build: SECOND }],
    state: { attention: "Response ready", phase: { kind: "building" } },
    commands: [{ type: "build" }, { type: "build" }],
  },
  {
    name: "attention goes to the current chat when the new code fails",
    mode: "automatic",
    events: [...OPEN, CHANGED, ATTENTION, FAILED],
    state: { attention: undefined, phase: { kind: "running" } },
    commands: [{ type: "build" }, FAILURE, DELIVER],
  },
  {
    name: "without autoRestart, attention goes to the chat while the code waits for /restart",
    mode: "manual",
    events: [...OPEN, ...NEW_CODE, ATTENTION],
    state: { attention: undefined, phase: { kind: "ready" } },
    commands: [{ type: "build" }, { type: "check" }, conditions(["reload.code", "info"]), DELIVER],
  },
  {
    name: "a quit stops",
    mode: "automatic",
    events: [...OPEN, QUIT],
    state: { phase: { kind: "stopped", outcome: "quit" } },
    commands: [],
  },
  {
    name: "a chat that fails before it opens a session stops",
    mode: "automatic",
    events: [crashed(EARLY)],
    state: { phase: { kind: "stopped", outcome: "failed" } },
    commands: [],
  },
  {
    name: "a late crash restarts the same build",
    mode: "automatic",
    events: [...OPEN, crashed(LATE)],
    state: { phase: { kind: "running" }, current: FIRST },
    commands: [LOGGED, { type: "start", build: FIRST, session: "s1", draft: "" }],
  },
  {
    name: "a second early crash falls back to the last good build",
    mode: "automatic",
    events: [...SWITCHED, crashed(EARLY), crashed(EARLY)],
    state: { current: FIRST, lastGood: undefined },
    commands: [
      { type: "build" },
      { type: "check" },
      EXIT,
      { type: "start", build: SECOND },
      { type: "prune" },
      LOGGED,
      { type: "start", build: SECOND },
      LOGGED,
      { type: "start", build: FIRST },
      FALLBACK,
    ],
  },
  {
    name: "after a fallback, new code that starts clears the fallback",
    mode: "automatic",
    events: [...SWITCHED, crashed(EARLY), crashed(EARLY), ...OPEN, ...NEW_CODE, HANDOFF, QUIT],
    state: { current: SECOND, isOnLastGood: false },
    commands: [
      { type: "build" },
      { type: "check" },
      EXIT,
      { type: "start" },
      { type: "prune" },
      LOGGED,
      { type: "start" },
      LOGGED,
      { type: "start" },
      FALLBACK,
      { type: "build" },
      { type: "check" },
      EXIT,
      { type: "start", build: SECOND },
      { type: "prune" },
      NONE,
    ],
  },
  {
    name: "a second early crash with no older build stops",
    mode: "automatic",
    events: [...OPEN, crashed(EARLY), crashed(EARLY)],
    state: { phase: { kind: "stopped", outcome: "crashed" } },
    commands: [LOGGED, { type: "start", build: FIRST }],
  },
];

test.each(cases)("$name", ({ mode, events, state, commands }) => {
  const after = afterEvents(events, mode);
  expect(after.state).toMatchObject(state);
  expect(after.commands).toMatchObject(commands);
});

test("a failure shows its first line and keeps the whole reason as detail", () => {
  const { state } = afterEvents([...OPEN, CHANGED, FAILED], "automatic");

  expect(reloadConditions(state)).toEqual([
    {
      key: "reload.code",
      severity: "warning",
      text: "The new code does not build: x.ts:1",
      detail: "The new code does not build: x.ts:1\nmore",
    },
  ]);
});
