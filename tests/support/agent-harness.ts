/** A scripted model and a real agent on temp files, for tests of runs. */

import { BunServices } from "@effect/platform-bun";
import { Context, Duration, Effect, FileSystem, Layer, PubSub, type Scope, Stream } from "effect";
import { type AiError, LanguageModel, type Prompt, type Response } from "effect/ai";
import type { ChildProcessSpawner } from "effect/process";
import { Models } from "../../src/ai/Models.ts";
import { RouteId } from "../../src/ai/Routes.ts";
import { Agent, type OpenSession } from "../../src/core/Agent.ts";
import { OutputFolder } from "../../src/core/OutputFolder.ts";
import type { AgentEvent, RunOptions } from "../../src/core/Client.ts";
import { TauHome } from "../../src/database/TauHome.ts";
import { Settings } from "../../src/host/Settings.ts";
import { userInstructionsLayer } from "../../src/host/UserInstructions.ts";
import { Sessions } from "../../src/session/Sessions.ts";

export type Reply = Stream.Stream<Response.StreamPartEncoded, AiError.AiError>;

export const options: RunOptions = {
  model: { route: RouteId.make("scripted"), model: "scripted" },
  maxTurns: undefined,
  timeouts: { run: Duration.seconds(5), shell: Duration.seconds(5) },
};

export const textReply = (text: string): Reply =>
  Stream.make<Response.StreamPartEncoded[]>(
    { type: "text-start", id: "text" },
    { type: "text-delta", id: "text", delta: text },
    { type: "text-end", id: "text" },
  );

export const runReply = (id: string, code: string): Reply =>
  Stream.make<Response.StreamPartEncoded[]>({
    type: "tool-call",
    id,
    name: "run",
    params: { code },
  });

export const checksReply = (id: string): Reply =>
  Stream.make<Response.StreamPartEncoded[]>({ type: "tool-call", id, name: "checks", params: {} });

/** A model that answers with the next scripted reply and keeps each request it gets. */
const scriptedModels = (replies: readonly Reply[], requests: Requests) =>
  Layer.effect(
    Models,
    Effect.gen(function* () {
      const model = yield* LanguageModel.make({
        generateText: () => Effect.die("Tau streams every model call."),
        streamText: (request) => {
          const reply = replies[requests.prompts.length] ?? textReply("No more script.");
          requests.prompts.push(request.prompt);
          requests.tools.push(request.tools.map((tool) => tool.description ?? "").join("\n"));
          return reply;
        },
      });

      return Models.of({
        languageModel: () => Effect.succeed(model),
        decisionModel: () => Effect.die("Turn tests use no decision model."),
      });
    }),
  );

/** What the model got in each call: the prompt, and the descriptions of the tools. */
type Requests = { readonly prompts: Prompt.Prompt[]; readonly tools: string[] };

/** How reading the user's settings and folders can fail when an agent starts. */
type StartError = Layer.Error<typeof Settings.layer>;

type Harness = {
  /** The user's home folder; Tau's home is `.tau` in it. */
  readonly home: string;
  readonly directory: string;
  readonly prompts: Prompt.Prompt[];
  /** The tool descriptions of each model call. */
  readonly tools: string[];
  readonly startAgent: (
    replies: readonly Reply[],
  ) => Effect.Effect<Agent["Service"], StartError, Scope.Scope>;
  readonly sessions: Sessions["Service"];
};

type HarnessServices =
  | Scope.Scope
  | FileSystem.FileSystem
  | ChildProcessSpawner.ChildProcessSpawner;

/** Real SQLite, codemode and shell in a temp directory. Each `startAgent` builds a new agent on the same files. */
export const withHarness = <A, E>(
  program: (harness: Harness) => Effect.Effect<A, E, HarnessServices>,
) => withPreparedHarness(() => Effect.void, program);

/**
 * `withHarness`, with `prepare` run before the session store opens, such as to write a sessions
 * file in an earlier format. It gets the home folder and the session directory.
 */
export const withPreparedHarness = <A, E, P>(
  prepare: (home: string, directory: string) => Effect.Effect<void, P, HarnessServices>,
  program: (harness: Harness) => Effect.Effect<A, E, HarnessServices>,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const home = yield* fileSystem.makeTempDirectoryScoped();
      const directory = `${home}/work`;
      yield* fileSystem.makeDirectory(directory);
      yield* Effect.scoped(prepare(home, directory));

      const tauHome = TauHome.at(`${home}/.tau`);
      const store = yield* Layer.build(Sessions.layer.pipe(Layer.provide(tauHome)));
      const requests: Requests = { prompts: [], tools: [] };

      // Settings are read when an agent starts, so a test can write settings.json first.
      const user = userInstructionsLayer.pipe(
        Layer.provide(Settings.layer),
        Layer.provide(tauHome),
        Layer.provide(BunServices.layer),
      );

      const startAgent = (replies: readonly Reply[]) =>
        Layer.build(
          Agent.layer.pipe(
            Layer.provide(scriptedModels(replies, requests)),
            Layer.provide(Layer.succeedContext(store)),
            Layer.provide(BunServices.layer),
            Layer.provide(user),
            Layer.provide(Layer.succeed(OutputFolder, { directory: `${home}/output` })),
          ),
        ).pipe(Effect.map((context) => Context.get(context, Agent)));

      return yield* program({
        home,
        directory,
        ...requests,
        startAgent,
        sessions: Context.get(store, Sessions),
      });
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

/** Takes events until one matches, and gives every event taken. */
export const takeUntil = Effect.fn("takeUntil")(function* (
  events: PubSub.Subscription<AgentEvent>,
  isLast: (event: AgentEvent) => boolean,
) {
  const taken: AgentEvent[] = [];

  for (;;) {
    const event = yield* PubSub.take(events);
    taken.push(event);
    if (isLast(event)) return taken;
  }
});

export const isRunEnd = (event: AgentEvent) => event.type === "run-ended";

/** Sends a prompt and gives the run's events, through its end. */
export const prompt = Effect.fn("prompt")(function* (opened: OpenSession, text: string) {
  const events = yield* opened.subscribe;
  yield* opened.send({ type: "prompt", text, options });
  return yield* takeUntil(events, isRunEnd);
});

export const runEnd = (events: readonly AgentEvent[]) => events.find(isRunEnd);

/** The text of every tool result in a prompt, in order. */
export const toolResults = (sent: Prompt.Prompt | undefined) =>
  (sent?.content ?? []).flatMap((message) =>
    message.role === "tool"
      ? message.content.flatMap((part) =>
          part.type === "tool-result" ? [String(part.result)] : [],
        )
      : [],
  );

export const systemText = (sent: Prompt.Prompt | undefined) =>
  (sent?.content ?? []).flatMap((message) => (message.role === "system" ? [message.content] : []));

/** The text of every user message: prompts and instruction notes. */
export const userTexts = (sent: Prompt.Prompt | undefined) =>
  (sent?.content ?? []).flatMap((message) =>
    message.role === "user"
      ? message.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
      : [],
  );
