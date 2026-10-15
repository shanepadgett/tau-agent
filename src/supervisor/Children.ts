/**
 * Starts builds of Tau as child processes: the chat, which takes over the terminal, and the start
 * check, which loads a new build out of sight before the supervisor trusts it.
 */

import { Context, Duration, Effect, Layer, Option, Schema, type Scope, Stream } from "effect";
import { spawnIpcChild } from "../proc/IpcChild.ts";
import type { Build } from "./Builds.ts";
import { CheckFailedMessage, ToChild, ToSupervisor } from "./Messages.ts";

/** A chat build that loads takes about 300 ms to finish its check; one that hangs is broken. */
const CHECK_SECONDS = 10;

/** An error in the output, such as `error: …`, `Error: …` or `TypeError: …`, to the line's end. */
const ERROR_TEXT = /\w*error: .*/i;

type RunningChat = {
  readonly messages: Stream.Stream<ToSupervisor>;
  readonly send: (message: ToChild) => Effect.Effect<void>;
  /** The exit code. A clean quit and an exit for a restart are 0. */
  readonly exited: Effect.Effect<number>;
};

class CheckFailed extends Schema.TaggedError<CheckFailed>()("CheckFailed", {
  reason: Schema.String,
}) {}

const startChat = Effect.fn("startChat")(function* (
  build: Build,
  args: readonly string[],
  draft: string,
) {
  const child = yield* spawnIpcChild<ToChild>([...build.command, ...args], "terminal");
  yield* child.send({ type: "start-chat", draft });

  const chat: RunningChat = {
    messages: child.messages.pipe(Stream.filter(Schema.is(ToSupervisor))),
    send: child.send,
    exited: Effect.map(child.exited, ({ code }) => code),
  };

  return chat;
});

/** The start check reports why it failed; the output is the fallback for a crash before that. */
const check = Effect.fn("check")(function* (build: Build) {
  const child = yield* spawnIpcChild<ToChild>(build.command, "captured");
  yield* child.send({ type: "start-check" });

  const ended = yield* Effect.all([Stream.runCollect(child.messages), child.exited]).pipe(
    Effect.timeoutOption(Duration.seconds(CHECK_SECONDS)),
  );

  if (Option.isNone(ended)) {
    return yield* new CheckFailed({
      reason: `The new code did not start in ${CHECK_SECONDS} seconds.`,
    });
  }

  const [messages, { code, output }] = ended.value;
  if (code === 0) return;
  const reported = messages.find(Schema.is(CheckFailedMessage));
  const reason = reported?.reason ?? output.match(ERROR_TEXT)?.[0];
  return yield* new CheckFailed({ reason: reason ?? `The new code exited with ${code}.` });
}, Effect.scoped);

export class Children extends Context.Service<
  Children,
  {
    /** Starts the chat of `build` with Tau's `args`, and `draft` in its input editor. */
    readonly startChat: (
      build: Build,
      args: readonly string[],
      draft: string,
    ) => Effect.Effect<RunningChat, never, Scope.Scope>;
    /** Loads `build` without the terminal or the database, and fails when it does not start. */
    readonly check: (build: Build) => Effect.Effect<void, CheckFailed>;
  }
>()("tau/supervisor/Children") {
  static readonly layer = Layer.succeed(Children, { startChat, check });
}
