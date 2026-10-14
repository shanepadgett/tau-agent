/**
 * The edge between the chat's Solid components and core: it keeps the chat state in a Solid store
 * that core's events update, and turns the components' plain calls into Effects.
 */

import { Deferred, Effect, Stream } from "effect";
import { createStore, reconcile, unwrap } from "solid-js/store";
import type { OpenSession } from "../../core/Agent.ts";
import type { RunOptions } from "../../core/Client.ts";
import { type ChatAction, type ChatState, reduce, replay } from "./chat-state.ts";

/**
 * How the chat's runs behave. The chat opens without a model; until the user sets one, it does not
 * send prompts and says how to set one.
 */
export type ChatOptions = Omit<RunOptions, "model"> & {
  readonly model: RunOptions["model"] | undefined;
};

const NO_MODEL =
  'No model is set. Add "model": "route/model" to ~/.tau/settings.json, such as "anthropic/claude-sonnet-5-5", or pass --model, then open the chat again.';

export type ChatClient = {
  /** A Solid store: components that read it redraw when it changes. */
  readonly chat: ChatState;
  /** The model of each run, as `route/model`, or undefined when the user has not set one. */
  readonly model: string | undefined;
  readonly send: (text: string) => void;
  readonly cancel: () => void;
  readonly quit: () => void;
};

/**
 * Shows the session's history, then keeps the chat current with its events until the scope
 * closes. `quitting` completes when the user quits.
 */
export const chatClient = Effect.fn("chatClient")(function* (
  opened: OpenSession,
  options: ChatOptions,
) {
  const events = yield* opened.subscribe;
  const [chat, setChat] = createStore(replay(yield* opened.history));
  const quitRequested = yield* Deferred.make<void>();

  // `reconcile` keeps the objects whose `id` stays, so only the changed items redraw.
  const apply = (action: ChatAction) => {
    setChat(reconcile(reduce(unwrap(chat), action), { key: "id" }));
  };

  yield* Effect.forkScoped(
    Stream.fromSubscription(events).pipe(
      Stream.runForEach((event) =>
        Effect.sync(() => {
          apply(event);
        }),
      ),
    ),
  );

  const { model } = options;

  const client: ChatClient = {
    chat,
    model: model === undefined ? undefined : `${model.route}/${model.model}`,
    send: (text) => {
      if (model === undefined) {
        apply({ type: "prompt-refused", text, reason: NO_MODEL });
        return;
      }

      apply({ type: "prompt-sent", text });
      Effect.runFork(opened.send({ type: "prompt", text, options: { ...options, model } }));
    },
    cancel: () => Effect.runFork(opened.send({ type: "cancel" })),
    quit: () => Effect.runFork(Deferred.complete(quitRequested, Effect.void)),
  };

  return { client, quitting: Deferred.await(quitRequested) };
});
