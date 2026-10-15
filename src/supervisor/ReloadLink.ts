/**
 * The chat's side of the supervisor connection. Tau runs under a supervisor when its parent started
 * it with Bun IPC; otherwise it is the first Tau process and becomes the supervisor itself.
 */

import { Context, Deferred, Effect, Exit, Layer, Queue, Schema, Stream } from "effect";
import { type ReloadCondition, ToChild, type ToSupervisor } from "./Messages.ts";

type StartMessage = Extract<ToChild, { type: "start-check" | "start-chat" }>;

export type SupervisedLink = {
  readonly kind: "supervised";
  /** How the supervisor wants this process to start. */
  readonly start: Effect.Effect<StartMessage>;
  /** Completes when the supervisor wants the chat to end, so that the new code can start. */
  readonly exitRequested: Effect.Effect<void>;
  /** Each new list of the supervisor's conditions. Each list goes to one reader only. */
  readonly conditions: Stream.Stream<readonly ReloadCondition[]>;
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
      const exitRequested = yield* Deferred.make<void>();
      const conditions = yield* Queue.unbounded<readonly ReloadCondition[]>();

      const receive: NodeJS.MessageListener = (message) => {
        if (!Schema.is(ToChild)(message)) return;

        switch (message.type) {
          case "start-check":
          case "start-chat":
            Queue.offerUnsafe(starts, message);
            return;
          case "exit-for-restart":
            Deferred.doneUnsafe(exitRequested, Exit.void);
            return;
          case "conditions":
            Queue.offerUnsafe(conditions, message.conditions);
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
        exitRequested: Deferred.await(exitRequested),
        conditions: Stream.fromQueue(conditions),
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
