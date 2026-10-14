/**
 * Decides what the supervisor does next, as a pure function of its state and one event. The
 * supervisor runs the commands that `transition` returns and feeds the results back as events.
 */

import type { Build } from "../Builds.ts";
import type { ToChild, ToSupervisor } from "../messages.ts";

/** A chat that crashes this soon after its start crashed early. Two early crashes end a build. */
const EARLY_CRASH_MILLIS = 10_000;

const CHECKING = "Tau's code changed. Tau checks the new code now.";
const WAITING = "The new code passed its check. Tau restarts into it when the run ends.";
const MANUAL = "The new code passed its check. Type /restart to use it.";

/**
 * What the supervisor is doing about new code. `changedAgain` says that the code changed again
 * while the supervisor built, checked or switched, so it must build again after that. A chat that
 * stops before it opens a session has `failed`: it said why itself, and a restart cannot help.
 */
type Phase =
  | { readonly kind: "running" }
  | { readonly kind: "building"; readonly changedAgain: boolean }
  | { readonly kind: "checking"; readonly changedAgain: boolean }
  | { readonly kind: "ready"; readonly candidate: Build }
  | {
      readonly kind: "handing-over";
      readonly next: Build;
      readonly draft: string;
      readonly changedAgain: boolean;
    }
  | { readonly kind: "stopped"; readonly outcome: "quit" | "crashed" | "failed" };

export type RestartState = {
  readonly phase: Phase;
  /** The build of the chat that runs now. */
  readonly current: Build;
  /** The build that ran before `current`, for when `current` keeps crashing. */
  readonly lastGood: Build | undefined;
  readonly session: string | undefined;
  readonly isIdle: boolean;
  readonly isAutomatic: boolean;
  readonly isRestartRequested: boolean;
  readonly hasCrashedEarly: boolean;
};

export type RestartEvent =
  | { readonly type: "source-changed" }
  | { readonly type: "built"; readonly build: Build }
  | { readonly type: "checked"; readonly build: Build }
  /** The build or its start check failed. */
  | { readonly type: "failed"; readonly reason: string }
  | { readonly type: "message"; readonly message: ToSupervisor }
  | { readonly type: "exited"; readonly code: number; readonly ranMillis: number };

export type RestartCommand =
  | { readonly type: "build" }
  | { readonly type: "check"; readonly build: Build }
  | { readonly type: "send"; readonly message: ToChild }
  | {
      readonly type: "start";
      readonly build: Build;
      readonly session: string | undefined;
      readonly draft: string;
    }
  | { readonly type: "prune"; readonly keep: readonly Build[] };

type Step = { readonly state: RestartState; readonly commands: readonly RestartCommand[] };

/**
 * Whether new code that passed its check starts by itself, or waits for `/restart`. It comes from
 * the `autoRestart` setting.
 */
export type RestartMode = "automatic" | "manual";

/** The state while the first build runs. */
export const startingState = (first: Build, mode: RestartMode): RestartState => ({
  phase: { kind: "running" },
  current: first,
  lastGood: undefined,
  session: undefined,
  isIdle: false,
  isAutomatic: mode === "automatic",
  isRestartRequested: false,
  hasCrashedEarly: false,
});

export const transition = (state: RestartState, event: RestartEvent): Step => {
  if (state.phase.kind === "stopped") return stay(state);

  switch (event.type) {
    case "source-changed":
      return sourceChanged(state);
    case "built":
      return afterWork(state, { kind: "checking", changedAgain: false }, [
        { type: "check", build: event.build },
      ]);
    case "checked":
      return checked(afterWork(state, { kind: "ready", candidate: event.build }, []));
    case "failed":
      return afterWork(state, { kind: "running" }, [notice(event.reason)]);
    case "message":
      return messageArrived(state, event.message);
    case "exited":
      return state.phase.kind === "handing-over"
        ? handedOver(state, state.phase)
        : childEnded(state, event);
  }
};

const stay = (state: RestartState): Step => ({ state, commands: [] });

const notice = (text: string): RestartCommand => ({
  type: "send",
  message: { type: "notice", text },
});

const sourceChanged = (state: RestartState): Step => {
  const { phase } = state;

  if (phase.kind === "running" || phase.kind === "ready") {
    return {
      state: { ...state, phase: { kind: "building", changedAgain: false } },
      commands: [notice(CHECKING), { type: "build" }],
    };
  }

  if (phase.kind === "stopped") return stay(state);
  return stay({ ...state, phase: { ...phase, changedAgain: true } });
};

/** Moves on to `next` after a build or a check, or builds again when the code changed meanwhile. */
const afterWork = (state: RestartState, next: Phase, commands: readonly RestartCommand[]): Step => {
  const { phase } = state;
  const isStale = (phase.kind === "building" || phase.kind === "checking") && phase.changedAgain;

  if (isStale) {
    return {
      state: { ...state, phase: { kind: "building", changedAgain: false } },
      commands: [{ type: "build" }],
    };
  }

  return { state: { ...state, phase: next }, commands };
};

/** Switches to the checked build now, or says when the switch comes. */
const checked = (step: Step): Step => {
  const switched = switchWhenIdle(step.state);
  if (switched.state.phase.kind !== "ready") return addCommands(step, switched);
  const waitingFor = step.state.isAutomatic || step.state.isRestartRequested ? WAITING : MANUAL;
  return { state: step.state, commands: [...step.commands, notice(waitingFor)] };
};

const addCommands = (first: Step, second: Step): Step => ({
  state: second.state,
  commands: [...first.commands, ...second.commands],
});

const messageArrived = (state: RestartState, message: ToSupervisor): Step => {
  switch (message.type) {
    case "ready":
      return stay({ ...state, session: message.session });
    case "idle":
      return switchWhenIdle({ ...state, isIdle: message.idle });
    case "restart-request":
      return switchWhenIdle({ ...state, isRestartRequested: true });
    case "check-failed":
      return stay(state);
    case "handoff":
      return state.phase.kind === "handing-over"
        ? stay({
            ...state,
            session: message.session,
            phase: { ...state.phase, draft: message.draft },
          })
        : stay(state);
  }
};

/** Asks the chat to exit when it is idle and a build to switch to is wanted. */
const switchWhenIdle = (state: RestartState): Step => {
  const next = switchTarget(state);
  if (next === undefined || !state.isIdle) return stay(state);

  return {
    state: { ...state, phase: { kind: "handing-over", next, draft: "", changedAgain: false } },
    commands: [{ type: "send", message: { type: "exit-for-restart" } }],
  };
};

const switchTarget = (state: RestartState): Build | undefined => {
  const { phase } = state;
  const isWanted = state.isAutomatic || state.isRestartRequested;
  if (phase.kind === "ready" && isWanted) return phase.candidate;
  if (phase.kind === "running" && state.isRestartRequested) return state.current;
  return undefined;
};

/** Starts the next build after the chat exited for the switch. */
const handedOver = (state: RestartState, phase: Extract<Phase, { kind: "handing-over" }>): Step => {
  const isNewBuild = phase.next.id !== state.current.id;
  const lastGood = isNewBuild ? state.current : state.lastGood;
  const keep = lastGood === undefined ? [phase.next] : [phase.next, lastGood];

  const started: Step = {
    state: {
      ...state,
      phase: phase.changedAgain ? { kind: "building", changedAgain: false } : { kind: "running" },
      current: phase.next,
      lastGood,
      isIdle: false,
      isRestartRequested: false,
      hasCrashedEarly: false,
    },
    commands: [
      { type: "start", build: phase.next, session: state.session, draft: phase.draft },
      { type: "prune", keep },
    ],
  };

  return phase.changedAgain
    ? { ...started, commands: [...started.commands, { type: "build" }] }
    : started;
};

/** The chat quit, or crashed. A crash restarts it; repeated early crashes fall back or stop. */
const childEnded = (state: RestartState, exit: Extract<RestartEvent, { type: "exited" }>): Step => {
  if (exit.code === 0) return stay({ ...state, phase: { kind: "stopped", outcome: "quit" } });

  if (state.session === undefined)
    return stay({ ...state, phase: { kind: "stopped", outcome: "failed" } });

  const isEarly = exit.ranMillis < EARLY_CRASH_MILLIS;

  if (!isEarly || !state.hasCrashedEarly) {
    return restart({ ...state, hasCrashedEarly: isEarly }, state.current);
  }

  if (state.lastGood === undefined) {
    return stay({ ...state, phase: { kind: "stopped", outcome: "crashed" } });
  }

  return restart({ ...state, lastGood: undefined, hasCrashedEarly: false }, state.lastGood);
};

const restart = (state: RestartState, build: Build): Step => ({
  state: { ...state, current: build, isIdle: false },
  commands: [{ type: "start", build, session: state.session, draft: "" }],
});
