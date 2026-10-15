/**
 * The edge between the chat's Solid components and core: it keeps the chat state in a Solid store
 * that core's events update, and turns the components' plain calls into Effects.
 */

import { Deferred, Effect, Fiber, type Scope, Stream } from "effect";
import { type Accessor, createSignal } from "solid-js";
import { createStore, reconcile, unwrap } from "solid-js/store";
import type { Agent, OpenSession } from "../../core/Agent.ts";
import type { AgentEvent, RunOptions } from "../../core/Client.ts";
import type { Attention, NotificationOptions } from "../Notifications.ts";
import type { SidebarChoice } from "../../core/TuiMemory.ts";
import { type Condition, Status } from "../../core/Status.ts";
import { chatCommands, type CommandTarget } from "./chat-commands.ts";
import { type CommitFlow, commitFlow } from "./commit-flow.ts";
import { type ChatAction, type ChatState, isIdle, reduce, replay } from "./chat-state.ts";
import type { CommandInfo } from "./command-suggestions.ts";
import { type ListedModel, type ModelRef, refText } from "./model-picker.ts";
import type { SidebarMemory } from "./sidebar-state.ts";
import { turnAttention } from "./turn-attention.ts";
import { thinkingChoice } from "./thinking-choice.ts";
import type { PickerList } from "./Picker.tsx";

/**
 * How the chat's runs behave. The chat opens without a model; until the user sets one, it does not
 * send prompts and says how to set one.
 */
export type ChatOptions = Omit<RunOptions, "model"> & {
  readonly model: RunOptions["model"] | undefined;
};

type SessionId = OpenSession["session"]["id"];

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
  /** Attention that the chat before held for the reload, to request once this chat is up. */
  readonly attention: string | undefined;
  /**
   * Gives the supervisor the attention that a run's end asks for. The supervisor holds it while new
   * code loads, then has the chat that the user should see request it.
   */
  readonly holdAttention: (message: string) => Effect.Effect<void>;
  /** The messages that the supervisor has the chat request attention for now. */
  readonly deliveries: Stream.Stream<string>;
};

/**
 * What the chat asks of the agent besides its open session: the sessions of the folder and the
 * models for `/sessions` and `/model`, the favorite models, the sidebar's remembered choice, and opening the session the user picks, or a new one.
 */
export type ChatAgent = Pick<
  Agent["Service"],
  | "sessions"
  | "models"
  | "favoriteModels"
  | "toggleFavoriteModel"
  | "references"
  | "sidebarChoice"
  | "saveSidebarChoice"
> & {
  readonly open: (session: SessionId | undefined) => Effect.Effect<OpenSession, never, Scope.Scope>;
};

export type ChatSetup = {
  readonly options: ChatOptions;
  readonly notifications: NotificationOptions;
  /** The prompt to send first, if any. */
  readonly prompt: string | undefined;
  readonly link: RestartLink;
  readonly agent: ChatAgent;
};

/**
 * Why the chat ended. A restart keeps the unsent input for the next chat. Open asks for another
 * session, or a new one when `session` is undefined.
 */
export type ChatEnd =
  | { readonly reason: "quit" }
  | { readonly reason: "restart"; readonly draft: string }
  | { readonly reason: "open"; readonly session: SessionId | undefined };

const NO_MODEL =
  'No model is set. Pick one with /model, or add "model": "provider/model" to ~/.tau/settings.json.';

export type ChatClient = {
  /** A Solid store: components that read it redraw when it changes. */
  readonly chat: ChatState;
  /** The problems that are true now, as a Solid signal. */
  readonly conditions: Accessor<readonly Condition[]>;
  /** The model of each run, as `provider/model`, or undefined when the user has not set one. */
  readonly model: Accessor<string | undefined>;
  /** The thinking level of the next run, or undefined when the model offers no levels. */
  readonly thinking: Accessor<RunOptions["thinking"] | undefined>;
  /** Steps the thinking level up, wrapping to the lowest. Only between runs. */
  readonly stepThinking: () => void;
  /** `/commit`, whose panel shows while it runs. */
  readonly commit: CommitFlow;
  /** The open picker, if a command opened one. */
  readonly picker: Accessor<PickerList | undefined>;
  readonly closePicker: () => void;
  /** The commands that `send` runs, for the suggestion list. */
  readonly commands: readonly CommandInfo[];
  /** The text the input editor starts with. */
  readonly draft: string;
  /** The input editor gives the chat a way to read its text, for a restart. */
  readonly readDraftWith: (read: () => string) => void;
  /** Sends a prompt, or during a run a steering message, or runs a command. */
  readonly send: (text: string) => void;
  /** Sends a prompt that waits for the running prompt to end. */
  readonly queue: (text: string) => void;
  readonly cancel: () => void;
  readonly quit: () => void;
  /** Whether the user last left the docked sidebar open, and a way to save a new choice. */
  readonly sidebar: SidebarMemory;
};

/**
 * Shows the session's history, then keeps the chat current with its events until the scope
 * closes. `ended` completes when the user quits, picks another session, or the supervisor restarts
 * Tau.
 */
export const chatClient = Effect.fn("chatClient")(function* (
  opened: OpenSession,
  setup: ChatSetup,
  attention: Attention,
) {
  const { link, agent } = setup;
  const events = yield* opened.subscribe;
  const [chat, setChat] = createStore(replay(yield* opened.history));
  const ended = yield* Deferred.make<ChatEnd>();
  const end = (reason: ChatEnd) => Effect.runFork(Deferred.succeed(ended, reason));
  const editor = { read: () => "" };
  const reportActivity = activityReporter(link, chat);

  // `reconcile` keeps the objects whose `id` stays, so only the changed items redraw.
  const apply = (action: ChatAction) => {
    setChat(reconcile(reduce(unwrap(chat), action), { key: "id" }));
    reportActivity();
  };

  reportActivity();

  yield* followSession(events, apply, { link, attention });

  yield* Effect.forkScoped(Effect.andThen(link.exitRequested, restart(chat, editor, end)));
  const prompts = yield* promptSender({ opened, agent, chat, apply, options: setup.options });

  const { commit, run, list, picker, closePicker } = commandsOf(prompts, attention, {
    chat,
    apply,
    agent,
    opened,
    setModel: prompts.setModel,
    requestRestart: link.requestRestart,
    open: (session) => end({ reason: "open", session }),
    openNew: () => end({ reason: "open", session: undefined }),
  });

  const client: ChatClient = {
    chat,
    conditions: yield* conditionsSignal(),
    model: prompts.modelText,
    thinking: prompts.thinking,
    stepThinking: prompts.stepThinking,
    picker,
    closePicker,
    commit,
    commands: list,
    draft: link.draft,
    readDraftWith: (read) => {
      editor.read = read;
    },
    send: (text) => {
      const command = run(text);

      if (command === undefined) prompts.send(chat.run === "idle" ? "prompt" : "steer", text);
      else Effect.runFork(command);
    },
    queue: (text) => {
      prompts.send("prompt", text);
    },
    cancel: () => Effect.runFork(opened.send({ type: "cancel" })),
    quit: () => end({ reason: "quit" }),
    sidebar: yield* sidebarMemory(agent, apply),
  };

  return { client, ended: Deferred.await(ended) };
});

/**
 * Applies the session's events to the chat, as they come. A run's end goes to the supervisor, which
 * has the chat request attention once the reload settles; the chat also requests what the chat
 * before held, and each message the supervisor sends back later.
 */
const followSession = Effect.fn("followSession")(function* (
  events: Effect.Success<OpenSession["subscribe"]>,
  apply: (action: ChatAction) => void,
  attending: { readonly link: RestartLink; readonly attention: Attention },
) {
  const { link, attention } = attending;
  const notify = turnAttention({ request: link.holdAttention });
  yield* Effect.forkScoped(followEvents(events, apply, notify));
  yield* Effect.forkScoped(link.deliveries.pipe(Stream.runForEach(attention.request)));
  if (link.attention !== undefined) yield* Effect.forkScoped(attention.request(link.attention));
});

/** Applies the session's events to the chat, as they come. */
const followEvents = (
  events: Effect.Success<OpenSession["subscribe"]>,
  apply: (action: ChatAction) => void,
  notify: (event: AgentEvent) => Effect.Effect<void>,
) =>
  Stream.fromSubscription(events).pipe(
    Stream.runForEach((action) =>
      Effect.sync(() => {
        apply(action);
      }).pipe(Effect.andThen(notify(action))),
    ),
  );

/**
 * Ends the chat for a restart. Prompts and steering messages that wait for their run would be lost
 * with this process, so they go back to the input.
 */
const restart = (
  chat: ChatState,
  editor: { readonly read: () => string },
  end: (reason: ChatEnd) => void,
) =>
  Effect.sync(() => {
    const waiting = [...chat.steering, ...chat.queued].map((queued) => queued.text);
    const draft = [...waiting, editor.read()].filter((part) => part !== "").join("\n\n");
    end({ reason: "restart", draft });
  });

/**
 * Sends prompts and steering messages with the chat's model and thinking level, or refuses them while
 * it has no model. A resumed session goes on with the model and level of its latest reply.
 */
const promptSender = Effect.fn("promptSender")(function* (sender: {
  readonly opened: OpenSession;
  readonly agent: ChatAgent;
  readonly chat: ChatState;
  readonly options: ChatOptions;
  readonly apply: (action: ChatAction) => void;
}) {
  const { opened, chat, options, apply } = sender;
  const lastModel = yield* opened.lastModel;
  const listed = yield* modelsSignal(sender.agent);
  const [model, setModel] = createSignal<ModelRef | undefined>(lastModel ?? options.model);

  const thinking = thinkingChoice(lastModel?.thinking ?? options.thinking, () => {
    const ref = model();
    const found = listed().find((candidate) => sameModel(candidate.ref, ref));
    return found?.thinking ?? [];
  });

  const send = (type: "prompt" | "steer", text: string) => {
    const ref = model();

    if (ref === undefined) {
      apply({ type: "prompt-refused", text, reason: NO_MODEL });
      return;
    }

    apply({ type: type === "prompt" ? "prompt-sent" : "steer-sent", text });
    const runOptions = { ...options, model: ref, thinking: thinking.chosen() };
    Effect.runFork(opened.send({ type, text, options: runOptions }));
  };

  const modelText = () => {
    const ref = model();
    return ref === undefined ? undefined : refText(ref);
  };

  const stepThinking = () => {
    if (chat.run === "idle") thinking.step();
  };

  return { send, model, setModel, modelText, thinking: thinking.shown, stepThinking };
});

const sameModel = (left: ModelRef, right: ModelRef | undefined) =>
  left.provider === right?.provider && left.model === right.model;

/**
 * The models Tau can call, for the levels each offers. Empty until they load, or if they cannot.
 */
const modelsSignal = Effect.fn("modelsSignal")(function* (agent: ChatAgent) {
  const [listed, setListed] = createSignal<readonly ListedModel[]>([]);

  yield* Effect.forkScoped(
    agent.models.pipe(
      Effect.tap((models) => Effect.sync(() => setListed(models))),
      Effect.ignore,
    ),
  );

  return listed;
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

/** The sidebar's remembered choice. A save runs in the background and says when it fails. */
const sidebarMemory = Effect.fn("sidebarMemory")(function* (
  agent: ChatAgent,
  apply: (action: ChatAction) => void,
) {
  const remembered = yield* agent.sidebarChoice;

  const save = (choice: SidebarChoice) => {
    runInBackground(
      agent.saveSidebarChoice(choice).pipe(
        Effect.catchTag("TuiMemoryError", (error) =>
          Effect.sync(() => {
            apply({ type: "notice", text: `Could not save the sidebar choice to ${error.path}.` });
          }),
        ),
      ),
    );
  };

  const memory: SidebarMemory = { remembered, save };
  return memory;
});

const runInBackground = (effect: Effect.Effect<void>) => {
  Effect.runFork(effect);
};

/** The chat's commands, `/commit` among them. */
const commandsOf = (
  prompts: Pick<Effect.Success<ReturnType<typeof promptSender>>, "model" | "send">,
  attention: Attention,
  target: Omit<CommandTarget, "commit" | "fork">,
) => {
  const commit = commitFlow({
    attention,
    opened: target.opened,
    apply: target.apply,
    model: prompts.model,
    prompt: (text) => {
      prompts.send("prompt", text);
    },
    start: runStoppable,
  });

  return { commit, ...chatCommands({ ...target, fork: runInBackground, commit }) };
};

/** Runs `effect` in the background, and gives a way to stop it. */
const runStoppable = (effect: Effect.Effect<void>) => {
  const fiber = Effect.runFork(effect);

  return () => {
    Effect.runFork(Fiber.interrupt(fiber));
  };
};
