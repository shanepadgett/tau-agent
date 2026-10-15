/**
 * The edge between the chat's Solid components and core: it keeps the chat state in a Solid store
 * that core's events update, and turns the components' plain calls into Effects.
 */

import { Deferred, Effect, Stream } from "effect";
import { type Accessor, createSignal } from "solid-js";
import { createStore, reconcile, unwrap } from "solid-js/store";
import type { OpenSession } from "../../core/Agent.ts";
import type { RunOptions } from "../../core/Client.ts";
import { type Condition, Status } from "../../core/Status.ts";
import { type ChatAction, type ChatState, reduce, replay } from "./chat-state.ts";

/**
 * How the chat's runs behave. The chat opens without a model; until the user sets one, it does not
 * send prompts and says how to set one.
 */
export type ChatOptions = Omit<RunOptions, "model"> & {
  readonly model: RunOptions["model"] | undefined;
};

/** Idle means that no run is going and no prompt waits. */
type Activity = "idle" | "busy";

/** The chat's connection to the supervisor, which restarts Tau into new code. */
export type RestartLink = {
  /** The unsent input of the chat that ran before this one, or empty. */
  readonly draft: string;
  readonly reportActivity: (activity: Activity) => Effect.Effect<void>;
  /** Asks for a restart as soon as Tau is idle, for `/restart`. */
  readonly requestRestart: Effect.Effect<void>;
  /** Completes when the supervisor wants the chat to end, so that the new code can start. */
  readonly exitRequested: Effect.Effect<void>;
};

export type ChatSetup = {
  readonly options: ChatOptions;
  /** The prompt to send first, if any. */
  readonly prompt: string | undefined;
  readonly link: RestartLink;
};

/** Why the chat ended. A restart keeps the unsent input for the next chat. */
export type ChatEnd =
  | { readonly reason: "quit" }
  | { readonly reason: "restart"; readonly draft: string };

const NO_MODEL =
  'No model is set. Add "model": "route/model" to ~/.tau/settings.json, such as "anthropic/claude-sonnet-5-5", or pass --model, then open the chat again.';

const RESTART_COMMAND = "/restart";

export type ChatClient = {
  /** A Solid store: components that read it redraw when it changes. */
  readonly chat: ChatState;
  /** The problems that are true now, as a Solid signal. */
  readonly conditions: Accessor<readonly Condition[]>;
  /** The model of each run, as `route/model`, or undefined when the user has not set one. */
  readonly model: string | undefined;
  /** The text the input editor starts with. */
  readonly draft: string;
  /** The input editor gives the chat a way to read its text, for a restart. */
  readonly readDraftWith: (read: () => string) => void;
  readonly send: (text: string) => void;
  readonly cancel: () => void;
  readonly quit: () => void;
};

/**
 * Shows the session's history, then keeps the chat current with its events until the scope
 * closes. `ended` completes when the user quits or the supervisor restarts Tau.
 */
export const chatClient = Effect.fn("chatClient")(function* (
  opened: OpenSession,
  setup: ChatSetup,
) {
  const { options, link } = setup;
  const events = yield* opened.subscribe;
  const [chat, setChat] = createStore(replay(yield* opened.history));
  const ended = yield* Deferred.make<ChatEnd>();
  let readDraft = () => "";
  const reportActivity = activityReporter(link, chat);

  // `reconcile` keeps the objects whose `id` stays, so only the changed items redraw.
  const apply = (action: ChatAction) => {
    setChat(reconcile(reduce(unwrap(chat), action), { key: "id" }));
    reportActivity();
  };

  const applyEach = <A extends ChatAction>(stream: Stream.Stream<A>) =>
    Effect.forkScoped(
      stream.pipe(
        Stream.runForEach((action) =>
          Effect.sync(() => {
            apply(action);
          }),
        ),
      ),
    );

  reportActivity();
  yield* applyEach(Stream.fromSubscription(events));

  const conditions = yield* conditionsSignal();

  // Prompts that wait for their run would be lost with this process, so they go back to the input.
  const restart = Effect.suspend(() => {
    const draft = [...chat.queued.map((queued) => queued.text), readDraft()];
    const text = draft.filter((part) => part !== "").join("\n\n");
    return Deferred.succeed(ended, { reason: "restart", draft: text });
  });

  yield* Effect.forkScoped(Effect.andThen(link.exitRequested, restart));

  const { model } = options;

  const client: ChatClient = {
    chat,
    conditions,
    model: model === undefined ? undefined : `${model.route}/${model.model}`,
    draft: link.draft,
    readDraftWith: (read) => {
      readDraft = read;
    },
    send: (text) => {
      if (text === RESTART_COMMAND) {
        if (!isIdle(chat)) apply({ type: "restart-waiting" });
        Effect.runFork(link.requestRestart);
        return;
      }

      if (model === undefined) {
        apply({ type: "prompt-refused", text, reason: NO_MODEL });
        return;
      }

      apply({ type: "prompt-sent", text });
      Effect.runFork(opened.send({ type: "prompt", text, options: { ...options, model } }));
    },
    cancel: () => Effect.runFork(opened.send({ type: "cancel" })),
    quit: () => Effect.runFork(Deferred.succeed(ended, { reason: "quit" })),
  };

  return { client, ended: Deferred.await(ended) };
});

/** The conditions of `Status` as a Solid signal, kept current until the scope closes. */
const conditionsSignal = Effect.fn("conditionsSignal")(function* () {
  const [conditions, setConditions] = createSignal<readonly Condition[]>([]);
  const { current } = yield* Status;
  const update = (now: readonly Condition[]) => Effect.sync(() => setConditions(now));
  yield* Effect.forkScoped(current.pipe(Stream.runForEach(update)));
  return conditions;
});

/** Returns a function that tells the supervisor when the chat's activity changed since its last call. */
const activityReporter = (link: RestartLink, chat: ChatState) => {
  let reported: Activity | undefined;

  return () => {
    const activity = isIdle(chat) ? "idle" : "busy";
    if (activity === reported) return;
    reported = activity;
    Effect.runFork(link.reportActivity(activity));
  };
};

const isIdle = (chat: ChatState) => chat.run === "idle" && chat.queued.length === 0;
