/**
 * Decides what the supervisor does next, as a pure function of its state and one event. The
 * supervisor runs the commands that `transition` returns and feeds the results back as events.
 */

import type { Build } from "../Builds.ts";
import type { ReloadCondition, ResumeTarget, ToChild, ToSupervisor } from "../Messages.ts";

/** A chat that crashes this soon after its start crashed early. Two early crashes end a build. */
const EARLY_CRASH_MILLIS = 10_000;

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
  readonly session: ResumeTarget | undefined;
  readonly isIdle: boolean;
  readonly isAutomatic: boolean;
  readonly isRestartRequested: boolean;
  readonly hasCrashedEarly: boolean;
  /** Why the newest code did not build or start, until new code passes its check. */
  readonly newCodeFailure: string | undefined;
  /** The chat runs the last good build because the newer one kept crashing. */
  readonly isOnLastGood: boolean;
  /** Attention the chat asked for that waits until the reload settles. */
  readonly attention: string | undefined;
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
  /** A crash goes to the supervisor's log, since the chat that crashed cannot log it. */
  | { readonly type: "log"; readonly text: string }
  | {
      readonly type: "start";
      readonly build: Build;
      readonly session: ResumeTarget | undefined;
      readonly draft: string;
      /** Held attention for the new chat to request once it is up. */
      readonly attention: string | undefined;
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
  newCodeFailure: undefined,
  isOnLastGood: false,
  attention: undefined,
});

/**
 * Sends the chat the supervisor's conditions when they change, and to each new chat that has some
 * to show.
 */
export const transition = (state: RestartState, event: RestartEvent): Step =>
  deliverAttention(withConditions(state, nextStep(state, event)));

const withConditions = (state: RestartState, step: Step): Step => {
  const conditions = reloadConditions(step.state);
  const hasStarted = step.commands.some((command) => command.type === "start");
  const isNews = hasStarted && conditions.length > 0;
  const hasChanged = JSON.stringify(conditions) !== JSON.stringify(reloadConditions(state));
  if (!isNews && !hasChanged) return step;

  return {
    ...step,
    commands: [...step.commands, { type: "send", message: { type: "conditions", conditions } }],
  };
};

/**
 * Held attention means that the user has something to see, so it waits while new code builds,
 * checks or switches, and goes to the chat that has the result: the new chat when it starts, or the
 * current one when no reload comes.
 */
const deliverAttention = (step: Step): Step => {
  const { state } = step;
  if (state.attention === undefined || isReloadComing(state)) return step;

  return {
    state: { ...state, attention: undefined },
    commands: [
      ...step.commands,
      { type: "send", message: { type: "deliver-attention", message: state.attention } },
    ],
  };
};

const isReloadComing = (state: RestartState): boolean => {
  switch (state.phase.kind) {
    case "building":
    case "checking":
    case "handing-over":
      return true;
    case "ready":
      return state.isAutomatic;
    case "running":
    case "stopped":
      return false;
  }
};

/** What the chat shows about Tau's own code: a fallback, new code that fails, or code that waits. */
export const reloadConditions = (state: RestartState): readonly ReloadCondition[] => {
  const conditions: ReloadCondition[] = [];
  if (state.isOnLastGood) conditions.push(condition("reload.fallback", "error", FALLBACK));

  if (state.newCodeFailure !== undefined) {
    const [firstLine = ""] = state.newCodeFailure.split("\n");

    conditions.push({
      ...condition("reload.code", "warning", firstLine),
      detail: state.newCodeFailure,
    });
  } else if (state.phase.kind === "ready" && !state.isAutomatic) {
    conditions.push(condition("reload.code", "info", "New code is ready: send /restart."));
  }

  return conditions;
};

const FALLBACK = "Tau crashed twice soon after it started, so the last good build is running.";

const condition = (
  key: string,
  severity: ReloadCondition["severity"],
  text: string,
): ReloadCondition => ({ key, severity, text, detail: text });

const nextStep = (state: RestartState, event: RestartEvent): Step => {
  if (state.phase.kind === "stopped") return stay(state);

  switch (event.type) {
    case "source-changed":
      return sourceChanged(state);
    case "built":
      return afterWork(state, { kind: "checking", changedAgain: false }, [
        { type: "check", build: event.build },
      ]);
    case "checked":
      return checked(
        afterWork(
          { ...state, newCodeFailure: undefined },
          { kind: "ready", candidate: event.build },
          [],
        ),
      );
    case "failed":
      return afterWork({ ...state, newCodeFailure: event.reason }, { kind: "running" }, []);
    case "message":
      return messageArrived(state, event.message);
    case "exited":
      return state.phase.kind === "handing-over"
        ? handedOver(state, state.phase)
        : childEnded(state, event);
  }
};

const stay = (state: RestartState): Step => ({ state, commands: [] });

const sourceChanged = (state: RestartState): Step => {
  const { phase } = state;

  if (phase.kind === "running" || phase.kind === "ready") {
    return {
      state: { ...state, phase: { kind: "building", changedAgain: false } },
      commands: [{ type: "build" }],
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

/** Switches to the checked build now, or waits until the chat is idle or `/restart` asks. */
const checked = (step: Step): Step => addCommands(step, switchWhenIdle(step.state));

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
    case "attention":
      return stay({ ...state, attention: message.message });
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
  // Code that changed again builds next, so the attention keeps waiting for that build.
  const heldAgain = phase.changedAgain;

  const started: Step = {
    state: {
      ...state,
      phase: phase.changedAgain ? { kind: "building", changedAgain: false } : { kind: "running" },
      current: phase.next,
      lastGood,
      isIdle: false,
      isRestartRequested: false,
      hasCrashedEarly: false,
      isOnLastGood: isNewBuild ? false : state.isOnLastGood,
      attention: heldAgain ? state.attention : undefined,
    },
    commands: [
      {
        type: "start",
        build: phase.next,
        session: state.session,
        draft: phase.draft,
        attention: heldAgain ? undefined : state.attention,
      },
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

  const crash = `Tau exited with code ${exit.code} after ${exit.ranMillis} ms.`;

  if (!isEarly || !state.hasCrashedEarly) {
    return restart(
      { ...state, hasCrashedEarly: isEarly },
      state.current,
      `${crash} Restarting it.`,
    );
  }

  if (state.lastGood === undefined) {
    return stay({ ...state, phase: { kind: "stopped", outcome: "crashed" } });
  }

  const fallback = `${crash} It crashed twice soon after it started, so the last good build starts.`;

  return restart(
    { ...state, lastGood: undefined, hasCrashedEarly: false, isOnLastGood: true },
    state.lastGood,
    fallback,
  );
};

const restart = (state: RestartState, build: Build, reason: string): Step => ({
  state: { ...state, current: build, isIdle: false, attention: undefined },
  commands: [
    { type: "log", text: reason },
    { type: "start", build, session: state.session, draft: "", attention: undefined },
  ],
});
