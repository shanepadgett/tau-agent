/**
 * The agent: opens sessions, takes commands from clients and runs each prompt through the agent
 * loop. Each session has one writer: a prompt sent during a run waits until the run ends.
 */

import {
  Cause,
  Context,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Option,
  PubSub,
  Ref,
  type Scope,
  Semaphore,
} from "effect";
import type { ModelRef } from "../ai/catalog.ts";
import { Models } from "../ai/models.ts";
import { ConversationId } from "../ai/route-auth.ts";
import type { SessionId } from "../session/entry.ts";
import {
  type Session,
  type SessionNotFound,
  Sessions,
  type SessionStoreError,
} from "../session/sessions.ts";
import type { AgentEvent, Command, RunEnd } from "./client.ts";
import type { RunContext } from "./operations.ts";
import { scriptFunctions, type Timeouts } from "./run-tool.ts";
import { runSteps } from "./step.ts";

/** How runs in one session behave. */
export type RunOptions = {
  readonly model: ModelRef;
  readonly maxTurns: number | undefined;
  readonly timeouts: Timeouts;
};

type Runner = {
  readonly session: Session;
  readonly options: RunOptions;
  readonly events: PubSub.PubSub<AgentEvent>;
  readonly writer: Semaphore.Semaphore;
  readonly current: Ref.Ref<Option.Option<Fiber.Fiber<void>>>;
};

export class Agent extends Context.Service<
  Agent,
  {
    /** Opens a session for runs: an existing one by ID, or a new one in `directory`. */
    readonly open: (
      session: Option.Option<SessionId>,
      directory: string,
      options: RunOptions,
    ) => Effect.Effect<Session, SessionNotFound | SessionStoreError>;

    /** Events of the session from now on. Subscribe before sending, to miss nothing. */
    readonly subscribe: (
      session: SessionId,
    ) => Effect.Effect<PubSub.Subscription<AgentEvent>, never, Scope.Scope>;

    readonly send: (session: SessionId, command: Command) => Effect.Effect<void>;
  }
>()("tau/core/Agent") {}

const makeAgent = Effect.fn("makeAgent")(function* () {
  const sessions = yield* Sessions;
  const models = yield* Models;
  const services: RunServices = { sessions, models, fileSystem: yield* FileSystem.FileSystem };
  const scope = yield* Effect.scope;
  const runners = yield* Ref.make(new Map<SessionId, Runner>());

  const open = Effect.fn("Agent.open")(function* (
    id: Option.Option<SessionId>,
    directory: string,
    options: RunOptions,
  ) {
    const session = Option.isSome(id)
      ? yield* sessions.get(id.value)
      : yield* sessions.create(directory);

    const runner: Runner = {
      session,
      options,
      events: yield* PubSub.unbounded<AgentEvent>(),
      writer: yield* Semaphore.make(1),
      current: yield* Ref.make(Option.none<Fiber.Fiber<void>>()),
    };

    yield* Ref.update(runners, (all) => new Map(all).set(session.id, runner));
    return session;
  });

  const runnerOf = (session: SessionId) =>
    Ref.get(runners).pipe(
      Effect.flatMap((all) => Effect.fromOption(Option.fromUndefinedOr(all.get(session)))),
      // Clients send only to sessions they opened.
      Effect.orDie,
    );

  const send = Effect.fn("Agent.send")(function* (session: SessionId, command: Command) {
    const runner = yield* runnerOf(session);

    if (command.type === "cancel") {
      const current = yield* Ref.get(runner.current);
      if (Option.isSome(current)) yield* Fiber.interrupt(current.value);
      return;
    }

    const fiber = yield* Effect.forkIn(runPrompt(services, runner, command.text), scope);
    yield* Ref.set(runner.current, Option.some(fiber));
  });

  return Agent.of({
    open,
    subscribe: (session) =>
      runnerOf(session).pipe(Effect.flatMap((runner) => PubSub.subscribe(runner.events))),
    send,
  });
});

export const agentLayer = Layer.effect(Agent, makeAgent());

type RunServices = {
  readonly sessions: Sessions["Service"];
  readonly models: Models["Service"];
  readonly fileSystem: FileSystem.FileSystem;
};

/** Saves the prompt and runs the agent loop. Waits for the session's writer, so runs never overlap. */
const runPrompt = (services: RunServices, runner: Runner, text: string) => {
  const { sessions, models, fileSystem } = services;
  const { session, options, events } = runner;

  const run = Effect.gen(function* () {
    yield* sessions.append(session.id, [{ type: "user", text }]);

    const context: RunContext<FileSystem.FileSystem> = {
      session: session.id,
      model: options.model,
      languageModel: yield* models.languageModel(options.model, ConversationId.make(session.id)),
      sessions,
      functions: scriptFunctions(session.directory, options.timeouts),
      timeouts: options.timeouts,
      maxTurns: options.maxTurns,
      emit: (event) => PubSub.publish(events, event).pipe(Effect.asVoid),
    };

    return yield* runSteps(context);
  });

  return run.pipe(
    Effect.provideService(FileSystem.FileSystem, fileSystem),
    Effect.onExit((exit) => PubSub.publish(events, runEnded(exit))),
    Effect.ignore,
    Semaphore.withPermit(runner.writer),
  );
};

const runEnded = (exit: Exit.Exit<RunEnd, unknown>): AgentEvent => {
  if (Exit.isSuccess(exit)) return { type: "run-ended", reason: exit.value };
  if (Cause.hasInterruptsOnly(exit.cause)) return { type: "run-ended", reason: "cancelled" };

  const error = Cause.squash(exit.cause);
  const message = error instanceof Error ? error.message : String(error);
  return { type: "run-ended", reason: "failed", error: message };
};
