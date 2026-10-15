/**
 * The supervisor: a small parent process that runs the chat as a child, restarts it into new code
 * when it is idle, and restarts it after a crash. Run it in place of the chat when Tau starts.
 */

import { Clock, Effect, Exit, Queue, Runtime, Schema, Scope, Stream } from "effect";
import { Builds } from "./Builds.ts";
import { Children } from "./Children.ts";
import {
  type RestartCommand,
  type RestartEvent,
  type RestartMode,
  type RestartState,
  startingState,
  transition,
} from "./internal/restart-machine.ts";
import type { ToChild } from "./Messages.ts";

export type SupervisorStart = {
  /**
   * Tau's arguments for a chat child. The first child gets the user's arguments; a later one
   * continues `session` and does not send the first prompt again.
   */
  readonly argsFor: (session: string | undefined) => readonly string[];
  readonly mode: RestartMode;
};

class TauCrashed extends Schema.TaggedError<TauCrashed>()("TauCrashed", {
  session: Schema.UndefinedOr(Schema.String),
}) {
  override get message() {
    const resume =
      this.session === undefined ? "" : ` Continue the session with: tau --session ${this.session}`;

    return `Tau crashed twice soon after it started, and no older build is left to use.${resume}`;
  }
}

/** The chat stopped before it opened a session, and it printed why. Only the exit code is left. */
class ChatFailed extends Schema.TaggedError<ChatFailed>()("ChatFailed", {}) {
  override readonly [Runtime.errorReported] = false;
}

type Offer = (event: RestartEvent) => Effect.Effect<void>;
type StartCommand = Extract<RestartCommand, { type: "start" }>;

/** A started chat, and the scope that holds its process and the fibers that read it. */
type ChatChild = {
  readonly send: (message: ToChild) => Effect.Effect<void>;
  readonly scope: Scope.Closeable;
};

/** Runs the chat until the user quits it. Fails when the chat keeps crashing. */
export const superviseChat = Effect.fn("superviseChat")(function* (start: SupervisorStart) {
  const builds = yield* Builds;
  const events = yield* Queue.unbounded<RestartEvent>();
  const offer: Offer = (event) => Queue.offer(events, event).pipe(Effect.asVoid);

  yield* Effect.forkScoped(
    builds.changes.pipe(Stream.runForEach(() => offer({ type: "source-changed" }))),
  );

  const first = yield* builds.first;
  let state: RestartState = startingState(first, start.mode);
  const firstStart: StartCommand = { type: "start", build: first, session: undefined, draft: "" };
  let chat = yield* startChat(firstStart, start, offer);

  while (state.phase.kind !== "stopped") {
    const step = transition(state, yield* Queue.take(events));
    state = step.state;
    for (const command of step.commands) chat = yield* runCommand(command, chat, start, offer);
  }

  yield* Scope.close(chat.scope, Exit.void);
  if (state.phase.outcome === "failed") return yield* new ChatFailed();
  if (state.phase.outcome === "crashed") return yield* new TauCrashed({ session: state.session });
}, Effect.scoped);

/** Runs one command of the restart machine and returns the chat that runs afterwards. */
const runCommand = Effect.fn("runCommand")(function* (
  command: RestartCommand,
  chat: ChatChild,
  start: SupervisorStart,
  offer: Offer,
) {
  const builds = yield* Builds;
  const children = yield* Children;

  switch (command.type) {
    case "build":
      yield* Effect.forkScoped(
        builds.build.pipe(
          Effect.matchEffect({
            onFailure: ({ reason }) =>
              offer({ type: "failed", reason: `The new code does not build: ${reason}` }),
            onSuccess: (build) => offer({ type: "built", build }),
          }),
        ),
      );

      return chat;
    case "check":
      yield* Effect.forkScoped(
        children.check(command.build).pipe(
          Effect.matchEffect({
            onFailure: ({ reason }) =>
              offer({ type: "failed", reason: `The new code does not start: ${reason}` }),
            onSuccess: () => offer({ type: "checked", build: command.build }),
          }),
        ),
      );

      return chat;
    case "send":
      yield* chat.send(command.message);
      return chat;
    case "log":
      yield* Effect.logError(command.text);
      return chat;
    case "start":
      yield* Scope.close(chat.scope, Exit.void);
      return yield* startChat(command, start, offer);
    case "prune":
      yield* Effect.forkScoped(builds.prune(command.keep));
      return chat;
  }
});

/** Starts a chat child, and reports its messages and its exit as events. */
const startChat = Effect.fn("startChat")(function* (
  command: StartCommand,
  start: SupervisorStart,
  offer: Offer,
) {
  const children = yield* Children;
  const scope = yield* Scope.make();

  const chat = yield* children
    .startChat(command.build, start.argsFor(command.session), command.draft)
    .pipe(Scope.provide(scope));

  const startedAt = yield* Clock.currentTimeMillis;

  // The exit comes after the last message, so the supervisor has the handoff when it sees the exit.
  const report = Effect.gen(function* () {
    yield* chat.messages.pipe(Stream.runForEach((message) => offer({ type: "message", message })));
    const code = yield* chat.exited;
    const ranMillis = (yield* Clock.currentTimeMillis) - startedAt;
    yield* offer({ type: "exited", code, ranMillis });
  });

  yield* Effect.forkIn(report, scope);

  const child: ChatChild = { send: chat.send, scope };
  return child;
});
