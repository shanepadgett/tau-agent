/**
 * The chat's side of the supervisor connection. Tau runs under a supervisor when its parent started
 * it with Bun IPC; otherwise it is the first Tau process and becomes the supervisor itself.
 */

import { Context, Deferred, Effect, Exit, Layer, Queue, Schema, Stream } from "effect";
import { ToChild, type ToSupervisor } from "./messages.ts";

type StartMessage = Extract<ToChild, { type: "start-check" | "start-chat" }>;

export type SupervisedLink = {
  readonly kind: "supervised";
  /** How the supervisor wants this process to start. */
  readonly start: Effect.Effect<StartMessage>;
  /** What the supervisor says about new code. */
  readonly notices: Stream.Stream<string>;
  /** Completes when the supervisor wants the chat to end, so that the new code can start. */
  readonly exitRequested: Effect.Effect<void>;
  readonly send: (message: ToSupervisor) => Effect.Effect<void>;
};

export class ReloadLink extends Context.Service<
  ReloadLink,
  { readonly kind: "unsupervised" } | SupervisedLink
>()("tau/supervisor/ReloadLink") {
  /**
   * Listens to the supervisor while the layer's scope is open. Closing the scope disconnects, so
   * the process can exit.
   */
  static readonly layer = Layer.effect(
    ReloadLink,
    Effect.gen(function* () {
      if (process.send === undefined) return { kind: "unsupervised" } as const;

      const starts = yield* Queue.unbounded<StartMessage>();
      const notices = yield* Queue.unbounded<string>();
      const exitRequested = yield* Deferred.make<void>();

      const receive: NodeJS.MessageListener = (message) => {
        if (!Schema.is(ToChild)(message)) return;

        switch (message.type) {
          case "start-check":
          case "start-chat":
            Queue.offerUnsafe(starts, message);
            return;
          case "notice":
            Queue.offerUnsafe(notices, message.text);
            return;
          case "exit-for-restart":
            Deferred.doneUnsafe(exitRequested, Exit.void);
        }
      };

      yield* Effect.acquireRelease(
        Effect.sync(() => process.on("message", receive)),
        () =>
          Effect.sync(() => {
            process.off("message", receive);
            process.disconnect?.();
          }),
      );

      const link: SupervisedLink = {
        kind: "supervised",
        start: Queue.take(starts),
        notices: Stream.fromQueue(notices),
        exitRequested: Deferred.await(exitRequested),
        // The callback runs once the message is on its way, so a handoff sent just before the
        // process disconnects still arrives.
        send: (message) =>
          Effect.callback<void>((resume) => {
            process.send?.(message, undefined, undefined, () => {
              resume(Effect.void);
            });
          }),
      };

      return link;
    }),
  );
}
