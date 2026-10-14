/**
 * The process sessions of one Tau session: commands the agent starts, leaves running and comes back
 * to. Closing the scope that made the registry kills every command and what it started.
 */

import { Clock, Duration, Effect, Fiber, Option, PubSub, Ref, Schema, Scope, Stream } from "effect";
import { ChildProcessSpawner } from "effect/process";
import { makeSessionBuffer, type SessionBuffer } from "./internal/session-buffer.ts";
import { spawnPipes } from "./internal/spawn-pipes.ts";
import { spawnPty } from "./internal/spawn-pty.ts";
import type { Transport } from "./internal/transport.ts";

class ProcessStartFailed extends Schema.TaggedError<ProcessStartFailed>()("ProcessStartFailed", {
  command: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message() {
    return `The command could not start: ${this.command}`;
  }
}

class ProcessLimit extends Schema.TaggedError<ProcessLimit>()("ProcessLimit", {
  limit: Schema.Int,
}) {
  override get message() {
    return `${this.limit} process sessions are running. Kill one before starting another.`;
  }
}

class UnknownProcess extends Schema.TaggedError<UnknownProcess>()("UnknownProcess", {
  id: Schema.String,
}) {
  override get message() {
    return `There is no process session ${this.id}. List the sessions to see their ids.`;
  }
}

class ProcessNotRunning extends Schema.TaggedError<ProcessNotRunning>()("ProcessNotRunning", {
  id: Schema.String,
}) {
  override get message() {
    return `Process session ${this.id} is not running, so it takes no input.`;
  }
}

const MILLIS_PER_SECOND = 1000;
const TAIL_LINES = 10;
const DRAIN_MILLIS = 200;
/** How long output may still arrive after a command exits. */
const DRAIN = Duration.millis(DRAIN_MILLIS);

export type ProcessLimits = {
  readonly maxSessions: number;
  /** Characters kept per session: the first half and the last half of its output. */
  readonly bufferCharacters: number;
};

export const PROCESS_LIMITS: ProcessLimits = { maxSessions: 64, bufferCharacters: 1_048_576 };

export type ProcessState =
  | { readonly type: "running" }
  | { readonly type: "exited"; readonly exitCode: number }
  | { readonly type: "killed" };

export type ProcessSummary = {
  /** `p1`, `p2` and so on, numbered in the order the registry started them. */
  readonly id: string;
  readonly command: string;
  readonly pty: boolean;
  readonly state: ProcessState;
};

export type StartOptions = {
  readonly command: string;
  readonly directory: string;
  /** Run on a pseudo-terminal, for programs that need one. */
  readonly pty: boolean;
  /** How long `start` waits for the command to exit before it leaves it running. */
  readonly waitSeconds: number;
};

export type WaitConditions = {
  /** An output line that ends the wait. */
  readonly pattern: RegExp | undefined;
  /** Seconds without new output that end the wait. */
  readonly quietSeconds: number;
  readonly deadlineSeconds: number;
};

export type WaitResult =
  | { readonly reason: "exited"; readonly exitCode: number; readonly output: string }
  | { readonly reason: "killed"; readonly output: string }
  | {
      readonly reason: "matched" | "quiet" | "deadline";
      /** Output since the last read. */
      readonly output: string;
      /** The last lines of all output, set only when no new output arrived. */
      readonly tail: string | undefined;
    };

/** A started command, and what happened while `start` waited for it to exit. */
export type StartedProcess = { readonly process: ProcessSummary; readonly waited: WaitResult };

/** A command that exited by itself and has not been reported yet. */
export type ProcessExit = { readonly process: ProcessSummary; readonly tail: string };

export type ProcessSessions = {
  readonly start: (
    options: StartOptions,
  ) => Effect.Effect<StartedProcess, ProcessLimit | ProcessStartFailed>;
  readonly list: Effect.Effect<readonly ProcessSummary[]>;
  /** The output since the last read. */
  readonly read: (
    id: string,
  ) => Effect.Effect<{ readonly output: string; readonly process: ProcessSummary }, UnknownProcess>;
  /** Everything the session kept, read or not. */
  readonly readAll: (id: string) => Effect.Effect<string, UnknownProcess>;
  readonly write: (
    id: string,
    text: string,
  ) => Effect.Effect<void, UnknownProcess | ProcessNotRunning>;
  readonly wait: (
    id: string,
    conditions: WaitConditions,
  ) => Effect.Effect<WaitResult, UnknownProcess>;
  readonly kill: (id: string) => Effect.Effect<ProcessSummary, UnknownProcess>;
  /** The commands that exited by themselves since the last call. Each is given once. */
  readonly takeExits: Effect.Effect<readonly ProcessExit[]>;
};

type LiveSession = {
  readonly id: string;
  readonly command: string;
  readonly pty: boolean;
  readonly transport: Transport;
  readonly buffer: SessionBuffer;
  readonly state: Ref.Ref<ProcessState>;
  /** Published when output arrives and when the state changes. */
  readonly changes: PubSub.PubSub<"changed">;
  readonly reported: Ref.Ref<boolean>;
};

const summaryOf = (session: LiveSession) =>
  Ref.get(session.state).pipe(
    Effect.map((state): ProcessSummary => {
      const { id, command, pty } = session;
      return { id, command, pty, state };
    }),
  );

/** Output arrives into the buffer, and the exit code settles the state once the output is drained. */
const watch = Effect.fn("watchProcess")(function* (session: LiveSession) {
  const reading = yield* session.transport.output.pipe(
    Stream.decodeText(),
    Stream.runForEach((text) =>
      Effect.sync(() => {
        session.buffer.append(text);
      }).pipe(Effect.andThen(PubSub.publish(session.changes, "changed"))),
    ),
    Effect.forkChild,
  );

  const exitCode = yield* session.transport.exitCode;
  yield* Fiber.join(reading).pipe(Effect.timeoutOption(DRAIN));

  yield* Ref.update(session.state, (state): ProcessState =>
    state.type === "running" ? { type: "exited", exitCode } : state,
  );

  yield* PubSub.publish(session.changes, "changed");
});

/** Whether a line of the text since `from` matches, and where the unfinished last line begins. */
const scanForPattern = (buffer: SessionBuffer, from: number, pattern: RegExp | undefined) => {
  const text = buffer.textFrom(from);
  const unfinished = text.length - (text.lastIndexOf("\n") + 1);

  return {
    matched: pattern !== undefined && text.split(/\r?\n/).some((line) => pattern.test(line)),
    scannedTo: buffer.length() - unfinished,
  };
};

const finished = Effect.fn("finishedProcess")(function* (
  session: LiveSession,
  state: ProcessState,
) {
  yield* Ref.set(session.reported, true);
  const output = session.buffer.takeUnread();

  const waited: WaitResult =
    state.type === "exited"
      ? { reason: "exited", exitCode: state.exitCode, output }
      : { reason: "killed", output };

  return waited;
});

const paused = (session: LiveSession, reason: "matched" | "quiet" | "deadline") =>
  Effect.sync(() => {
    const output = session.buffer.takeUnread();
    const tail = output === "" ? session.buffer.lastLines(TAIL_LINES) : undefined;
    const waited: WaitResult = { reason, output, tail };

    return waited;
  });

/** Returns when the command ends, a line matches, no output comes for a while, or time runs out. */
const waitFor = Effect.fn("waitForProcess")(function* (
  session: LiveSession,
  conditions: WaitConditions,
) {
  const changes = yield* PubSub.subscribe(session.changes);
  const begin = yield* Clock.currentTimeMillis;
  const deadlineAt = begin + conditions.deadlineSeconds * MILLIS_PER_SECOND;
  const quietMillis = conditions.quietSeconds * MILLIS_PER_SECOND;
  let quietAt = begin + quietMillis;
  let scanned = session.buffer.readOffset();

  for (;;) {
    const state = yield* Ref.get(session.state);
    if (state.type !== "running") return yield* finished(session, state);

    const scan = scanForPattern(session.buffer, scanned, conditions.pattern);
    scanned = scan.scannedTo;
    if (scan.matched) return yield* paused(session, "matched");

    const now = yield* Clock.currentTimeMillis;
    const wakeAt = Math.min(quietAt, deadlineAt);
    if (now >= wakeAt) return yield* paused(session, now >= deadlineAt ? "deadline" : "quiet");

    const arrived = yield* PubSub.take(changes).pipe(
      Effect.timeoutOption(Duration.millis(wakeAt - now)),
    );

    if (Option.isSome(arrived)) quietAt = (yield* Clock.currentTimeMillis) + quietMillis;
  }
}, Effect.scoped);

type Registry = Ref.Ref<readonly LiveSession[]>;

const findSession = (registry: Registry, id: string) =>
  Ref.get(registry).pipe(
    Effect.flatMap((sessions) => {
      const session = sessions.find((candidate) => candidate.id === id);

      return session === undefined
        ? Effect.fail(new UnknownProcess({ id }))
        : Effect.succeed(session);
    }),
  );

const listSessions = (registry: Registry) =>
  Ref.get(registry).pipe(Effect.flatMap((sessions) => Effect.forEach(sessions, summaryOf)));

const makeLiveSession = Effect.fn("makeLiveSession")(function* (
  id: string,
  options: StartOptions,
  transport: Transport,
  bufferCharacters: number,
) {
  const session: LiveSession = {
    id,
    command: options.command,
    pty: options.pty,
    transport,
    buffer: makeSessionBuffer(bufferCharacters),
    state: yield* Ref.make<ProcessState>({ type: "running" }),
    changes: yield* PubSub.sliding<"changed">(1),
    reported: yield* Ref.make(false),
  };

  return session;
});

const readSession = Effect.fn("readProcess")(function* (session: LiveSession) {
  const output = session.buffer.takeUnread();
  const process = yield* summaryOf(session);
  if (process.state.type !== "running") yield* Ref.set(session.reported, true);

  return { output, process };
});

const writeSession = Effect.fn("writeProcess")(function* (session: LiveSession, text: string) {
  if ((yield* Ref.get(session.state)).type !== "running")
    return yield* new ProcessNotRunning({ id: session.id });

  yield* session.transport.write(text);
});

const killSession = Effect.fn("killProcess")(function* (session: LiveSession) {
  yield* Ref.update(session.state, (state): ProcessState =>
    state.type === "running" ? { type: "killed" } : state,
  );

  yield* session.transport.kill;
  yield* PubSub.publish(session.changes, "changed");

  return yield* summaryOf(session);
});

const takeExitsFrom = Effect.fn("takeProcessExits")(function* (registry: Registry) {
  const exits: ProcessExit[] = [];

  for (const session of yield* Ref.get(registry)) {
    const process = yield* summaryOf(session);
    if (process.state.type !== "exited" || (yield* Ref.get(session.reported))) continue;

    yield* Ref.set(session.reported, true);
    exits.push({ process, tail: session.buffer.lastLines(TAIL_LINES) });
  }

  return exits;
});

/**
 * Makes the registry of one Tau session. Closing the scope it is made in kills every command, so
 * nothing the agent started outlives the session.
 */
export const makeProcessSessions = Effect.fn("makeProcessSessions")(function* (
  limits: ProcessLimits,
) {
  const scope = yield* Scope.Scope;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const registry: Registry = yield* Ref.make<readonly LiveSession[]>([]);
  const nextNumber = yield* Ref.make(1);

  yield* Effect.addFinalizer(() =>
    Ref.get(registry).pipe(
      Effect.flatMap((sessions) =>
        Effect.forEach(sessions, (session) => session.transport.kill, {
          concurrency: "unbounded",
          discard: true,
        }),
      ),
    ),
  );

  const start = Effect.fn("startProcess")(function* (options: StartOptions) {
    const known = yield* listSessions(registry);
    const running = known.filter(({ state }) => state.type === "running").length;

    if (running >= limits.maxSessions)
      return yield* new ProcessLimit({ limit: limits.maxSessions });

    const shell = { command: options.command, directory: options.directory };

    const startFailed = (cause: unknown) =>
      new ProcessStartFailed({ command: options.command, cause });

    const spawning = options.pty
      ? spawnPty(shell).pipe(Effect.mapError(startFailed))
      : spawnPipes(shell).pipe(Effect.mapError(startFailed));

    const transport = yield* spawning.pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );

    const id = `p${yield* Ref.getAndUpdate(nextNumber, (number) => number + 1)}`;
    const session = yield* makeLiveSession(id, options, transport, limits.bufferCharacters);
    yield* Ref.update(registry, (sessions) => [...sessions, session]);
    yield* Effect.forkIn(watch(session), scope);

    const waited = yield* waitFor(session, {
      pattern: undefined,
      quietSeconds: Number.POSITIVE_INFINITY,
      deadlineSeconds: options.waitSeconds,
    });

    const started: StartedProcess = { process: yield* summaryOf(session), waited };

    return started;
  });

  const sessions: ProcessSessions = {
    start,
    list: listSessions(registry),
    read: (id) => findSession(registry, id).pipe(Effect.flatMap(readSession)),
    readAll: (id) =>
      findSession(registry, id).pipe(Effect.map((session) => session.buffer.whole())),
    write: (id, text) =>
      findSession(registry, id).pipe(Effect.flatMap((session) => writeSession(session, text))),
    wait: (id, conditions) =>
      findSession(registry, id).pipe(Effect.flatMap((session) => waitFor(session, conditions))),
    kill: (id) => findSession(registry, id).pipe(Effect.flatMap(killSession)),
    takeExits: takeExitsFrom(registry),
  };

  return sessions;
});
