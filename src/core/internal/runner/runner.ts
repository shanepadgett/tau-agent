/**
 * The runner of one session: it takes prompts in order and runs one at a time, so a session has
 * one writer. A cancel stops the running prompt and gives back the waiting ones.
 */

import {
  Cause,
  Effect,
  Exit,
  Fiber,
  FiberHandle,
  FileSystem,
  PubSub,
  Queue,
  type Scope,
} from "effect";
import { ChildProcessSpawner } from "effect/process";
import { ConversationId } from "../../../ai/ConversationId.ts";
import type { Models } from "../../../ai/Models.ts";
import type { SessionId } from "../../../session/Entry.ts";
import type { Session, Sessions } from "../../../session/Sessions.ts";
import type { AgentEvent, Command } from "../../Client.ts";
import type { Outcome, RunContext } from "../loop/run-context.ts";
import { instructionsUpdate } from "../instructions/instructions.ts";
import { instructionSources } from "../instructions/sources.ts";
import { runSteps } from "../loop/step.ts";
import { scriptFunctions } from "../run-tool/run-tool.ts";
import { failureText } from "./failure-text.ts";

/** What scripts reach the computer through. */
type Platform = FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner;

export type RunServices = {
  readonly sessions: Sessions["Service"];
  readonly models: Models["Service"];
  readonly fileSystem: FileSystem.FileSystem;
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  /** The user's own instruction files, most shared first. */
  readonly userInstructions: readonly string[];
};

/** A session opened for runs. */
export type OpenSession = {
  readonly session: Session;
  /** Events of the session from now on. Subscribe before sending, to miss nothing. */
  readonly subscribe: Effect.Effect<PubSub.Subscription<AgentEvent>, never, Scope.Scope>;
  readonly send: (command: Command) => Effect.Effect<void>;
};

type QueuedPrompt = Extract<Command, { type: "prompt" }>;

/** How a run that was not cancelled ends. */
type Finished = Extract<Outcome, { type: "end" }>["reason"];

/** Starts the runner of session `id`. It stops, with its running prompt, when its scope closes. */
export const makeRunner = Effect.fn("makeRunner")(function* (services: RunServices, id: SessionId) {
  const session = yield* services.sessions.get(id);
  const events = yield* PubSub.unbounded<AgentEvent>();
  const prompts = yield* Queue.unbounded<QueuedPrompt>();
  const current = yield* FiberHandle.make<Finished, unknown>();

  const runNext = Effect.gen(function* () {
    const prompt = yield* Queue.take(prompts);

    // The handle must hold the fiber before it starts: a run can publish an event, and a client
    // can cancel in answer, before a fiber that starts at once is handed back.
    const run = yield* FiberHandle.run(current, runPrompt(services, session, prompt, events), {
      startImmediately: false,
    });

    yield* PubSub.publish(events, runEnded(yield* Fiber.await(run)));
  });

  yield* Effect.forkScoped(Effect.forever(runNext));

  const cancel = Effect.gen(function* () {
    const waiting = yield* Queue.clear(prompts);

    if (waiting.length > 0) {
      const returned = waiting.map((prompt) => prompt.text);
      yield* PubSub.publish(events, { type: "prompts-returned", prompts: returned });
    }

    yield* FiberHandle.clear(current);
  });

  const send = (command: Command) =>
    command.type === "cancel" ? cancel : Queue.offer(prompts, command).pipe(Effect.asVoid);

  const opened: OpenSession = { session, subscribe: PubSub.subscribe(events), send };
  return opened;
});

/** Saves the prompt and runs the agent loop on it. */
const runPrompt = (
  services: RunServices,
  session: Session,
  prompt: QueuedPrompt,
  events: PubSub.PubSub<AgentEvent>,
) =>
  Effect.gen(function* () {
    const { sessions, models } = services;
    const { model, timeouts, maxTurns } = prompt.options;
    yield* sessions.append(session.id, [{ type: "user", text: prompt.text }]);

    const context: RunContext<Platform> = {
      session: session.id,
      model,
      languageModel: yield* models.languageModel(model, ConversationId.make(session.id)),
      sessions,
      functions: (touched) => scriptFunctions(session.directory, timeouts, touched),
      updateInstructions: (entries) =>
        instructionSources(
          { directory: session.directory, userInstructions: services.userInstructions },
          entries,
        ).pipe(Effect.flatMap((sources) => instructionsUpdate(sources, entries))),
      timeouts,
      maxTurns,
      emit: (event) => PubSub.publish(events, event).pipe(Effect.asVoid),
    };

    return yield* runSteps(context);
  }).pipe(
    Effect.provideService(FileSystem.FileSystem, services.fileSystem),
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, services.spawner),
  );

const runEnded = (exit: Exit.Exit<Finished, unknown>): AgentEvent => {
  if (Exit.isSuccess(exit)) return { type: "run-ended", reason: exit.value };

  if (Cause.hasInterruptsOnly(exit.cause)) return { type: "run-ended", reason: "cancelled" };

  return { type: "run-ended", reason: "failed", error: failureText(exit.cause) };
};
