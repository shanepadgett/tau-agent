/**
 * The chat under the supervisor. The first `tau` process supervises; each chat runs in a child
 * process that the supervisor restarts into new code, with the same session and unsent input.
 */

import { dirname, resolve } from "node:path";
import { Cause, Effect, Layer, Option, Stream } from "effect";
import { Agent } from "../../core/Agent.ts";
import { Settings } from "../../host/Settings.ts";
import { Status } from "../../core/Status.ts";
import type { SessionId } from "../../session/Entry.ts";
import { Builds } from "../../supervisor/Builds.ts";
import { Children } from "../../supervisor/Children.ts";
import type { ReloadCondition } from "../../supervisor/Messages.ts";
import type { SupervisedLink } from "../../supervisor/ReloadLink.ts";
import type { SupervisorStart } from "../../supervisor/Supervisor.ts";
import type { ChatAgent, ChatOptions, ChatSetup, RestartLink } from "../../tui/Tui.ts";
import { agentLayer, openSession, printSessionId } from "./agent-session.ts";

/** The command line flags that the chat uses. */
export type ChatFlags = {
  readonly session: Option.Option<string>;
  readonly model: Option.Option<string>;
  readonly prompt: Option.Option<string>;
};

/**
 * Run from source with `bun`, Tau rebuilds itself from the repository it runs from. A released
 * binary has only itself to run.
 */
export const supervisorLayer = Layer.merge(
  Bun.main.endsWith(".ts")
    ? Builds.fromSource(resolve(dirname(Bun.main), "..", ".."))
    : Builds.binary,
  Children.layer,
);

/**
 * The arguments of each chat child. A later child continues the session that the first one
 * opened, and does not send the first prompt again.
 */
export const chatArgs =
  (flags: ChatFlags): SupervisorStart["argsFor"] =>
  (session) => {
    const model = Option.match(flags.model, {
      onNone: () => [],
      onSome: (ref) => ["--model", ref],
    });

    const resumed = Option.fromUndefinedOr(session).pipe(Option.orElse(() => flags.session));

    const sessionArgs = Option.match(resumed, {
      onNone: () => [],
      onSome: (id) => ["--session", id],
    });

    const prompt = session === undefined ? Option.toArray(flags.prompt) : [];
    return [...model, ...sessionArgs, ...prompt];
  };

/**
 * Runs what the supervisor asks for: the start check, which only loads the TUI, or the chat. The
 * check opens no database, so a new build cannot change it before it passes.
 */
export const runSupervisedChat = Effect.fn("runSupervisedChat")(function* (
  link: SupervisedLink,
  flags: ChatFlags,
  options: ChatOptions,
) {
  const start = yield* link.start;
  if (start.type === "start-check") return yield* checkStart(link);

  yield* chat(link, flags.session, {
    options,
    notifications: (yield* Settings).notifications,
    prompt: Option.getOrUndefined(flags.prompt),
    link: restartLink(link, start),
  });
});

/** Loads the TUI, and tells the supervisor why when it does not load. */
const checkStart = (link: SupervisedLink) =>
  loadChat.pipe(
    Effect.tapCause((cause) =>
      link.send({ type: "check-failed", reason: String(Cause.squash(cause)) }),
    ),
    Effect.asVoid,
  );

/**
 * Prints the ID of the session the chat showed last after the user quits, so the user can continue
 * it with `--session`.
 */
const chat = Effect.fn("chat")(
  function* (
    link: SupervisedLink,
    sessionFlag: Option.Option<string>,
    setup: Omit<ChatSetup, "agent">,
  ) {
    const opened = yield* openSession(sessionFlag);
    yield* link.send({ type: "ready", session: opened.session.id });
    yield* Effect.forkScoped(showConditions(link));
    const chatInTerminal = yield* loadChat;
    const end = yield* chatInTerminal(opened, { ...setup, agent: yield* chatAgent(link) });

    if (end.reason === "restart") {
      return yield* link.send({ type: "handoff", session: end.session, draft: end.draft });
    }

    yield* printSessionId(end.session);
  },
  Effect.scoped,
  Effect.provide(agentLayer),
);

/**
 * Loads the chat from the TUI module. Solid's JSX transform must be in place before its .tsx files
 * load. `bunfig.toml` adds it only when Bun starts in this repository, and Tau runs in other folders
 * too. `ensureSolidTransformPlugin` is what `@opentui/solid/preload` runs; that module has no types.
 */
const loadChat = Effect.gen(function* () {
  const solid = yield* Effect.promise(() => import("@opentui/solid/bun-plugin"));
  solid.ensureSolidTransformPlugin();
  return yield* Effect.promise(() => import("../../tui/Tui.ts").then((tui) => tui.chatInTerminal));
});

/**
 * Shows the supervisor's conditions in the chat: sets each new or changed one, and clears each one
 * that left the list.
 */
const showConditions = Effect.fn("showConditions")(function* (link: SupervisedLink) {
  const status = yield* Status;
  let shown: readonly ReloadCondition[] = [];

  const isShown = (condition: ReloadCondition) =>
    shown.some((old) => JSON.stringify(old) === JSON.stringify(condition));

  const show = Effect.fn("show")(function* (conditions: readonly ReloadCondition[]) {
    const keys = new Set(conditions.map((condition) => condition.key));
    const cleared = shown.filter((old) => !keys.has(old.key));
    yield* Effect.forEach(cleared, (old) => status.clear(old.key), { discard: true });
    const changed = conditions.filter((condition) => !isShown(condition));
    const set = ({ detail, ...condition }: ReloadCondition) => status.set(condition, detail);
    yield* Effect.forEach(changed, set, { discard: true });
    shown = conditions;
  });

  yield* link.conditions.pipe(Stream.runForEach(show));
});

/**
 * The agent as the chat uses it. Each session the chat opens is the one the supervisor restarts
 * into. A session from the folder's list is there to open, so a failure to open it is a defect.
 */
const chatAgent = Effect.fn("chatAgent")(function* (link: SupervisedLink) {
  const agent = yield* Agent;

  const open = (session: SessionId | undefined) =>
    agent.open(Option.fromUndefinedOr(session), process.cwd()).pipe(
      Effect.tap((opened) => link.send({ type: "ready", session: opened.session.id })),
      Effect.orDie,
    );

  const chatAgent: ChatAgent = {
    open,
    sessions: agent.sessions,
    models: agent.models,
    favoriteModels: agent.favoriteModels,
    toggleFavoriteModel: agent.toggleFavoriteModel,
    references: agent.references,
    files: agent.files,
    sidebarChoice: agent.sidebarChoice,
    saveSidebarChoice: agent.saveSidebarChoice,
  };

  return chatAgent;
});

const restartLink = (
  link: SupervisedLink,
  start: Extract<Effect.Success<SupervisedLink["start"]>, { type: "start-chat" }>,
): RestartLink => ({
  draft: start.draft,
  attention: start.attention,
  holdAttention: (message) => link.send({ type: "attention", message }),
  deliveries: link.deliveries,
  reportActivity: (activity) => link.send({ type: "idle", idle: activity === "idle" }),
  requestRestart: link.send({ type: "restart-request" }),
  exitRequested: link.exitRequested,
});
