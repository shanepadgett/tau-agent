/** A scripted model and a real agent on temp files, for tests of runs. */

import { BunServices } from "@effect/platform-bun";
import {
  Context,
  Duration,
  Effect,
  FileSystem,
  type JsonSchema,
  Layer,
  PubSub,
  type Scope,
  Stream,
} from "effect";
import { type AiError, LanguageModel, type Prompt, type Response, Tool } from "effect/ai";
import type { ChildProcessSpawner } from "effect/process";
import type { ModelProfile } from "../../src/ai/ModelProfile.ts";
import { Models } from "../../src/ai/Models.ts";
import { ProviderId } from "../../src/ai/Providers.ts";
import { Agent, type OpenSession } from "../../src/core/Agent.ts";
import { ContextMethod } from "../../src/core/ContextMethod.ts";
import { OutputFolder } from "../../src/core/OutputFolder.ts";
import type { AgentEvent, RunOptions } from "../../src/core/Client.ts";
import { Status } from "../../src/core/Status.ts";
import { TauHome } from "../../src/database/TauHome.ts";
import { favoriteModelsLayer } from "../../src/host/FavoriteModels.ts";
import { Settings } from "../../src/host/Settings.ts";
import { userInstructionsLayer } from "../../src/host/UserInstructions.ts";
import { Sessions } from "../../src/session/Sessions.ts";
import { Notes } from "../../src/session/Notes.ts";

export type Reply = Stream.Stream<Response.StreamPartEncoded, AiError.AiError>;
type NoteReply = Effect.Effect<Response.PartEncoded[], AiError.AiError>;

export const options: RunOptions = {
  model: { provider: ProviderId.make("scripted"), model: "scripted" },
  thinking: "medium",
  maxTurns: undefined,
  timeouts: { run: Duration.seconds(5), shell: Duration.seconds(5) },
};

/** The scripted model: $1 per million input tokens and $2 per million output tokens. */
export const profile: ModelProfile = {
  id: "scripted",
  name: "Scripted",
  protocol: "openaiChat",
  contextTokens: 128000,
  outputTokens: 8000,
  price: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 },
  longContextPrice: undefined,
  supports: { tools: true, structuredOutput: false, reasoning: false, images: false },
  thinking: undefined,
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
const scriptedModels = (
  replies: readonly Reply[],
  requests: Requests,
  noteReplies: readonly NoteReply[],
) =>
  Layer.effect(
    Models,
    Effect.gen(function* () {
      const model = yield* LanguageModel.make({
        generateText: (request) => {
          requests.notePrompts.push(request.prompt);

          return (
            noteReplies[requests.notePrompts.length - 1] ??
            Effect.succeed<Response.PartEncoded[]>([
              { type: "text", text: "Saved background note." },
            ])
          );
        },
        streamText: (request) => {
          const reply = replies[requests.prompts.length] ?? textReply("No more script.");
          requests.prompts.push(request.prompt);
          requests.tools.push(request.tools.map((tool) => tool.description ?? "").join("\n"));
          requests.toolInputs.push(request.tools.map((tool) => Tool.getJsonSchema(tool)));
          return reply;
        },
      });

      return Models.of({
        available: Effect.succeed([]),
        profile: () => Effect.succeed(profile),
        languageModel: () => Effect.succeed(model),
        decisionModel: () => Effect.die("Turn tests use no decision model."),
        smallModel: (ref) => Effect.succeed(ref),
      });
    }),
  );

/**
 * What the model got in each call: the prompt, the descriptions of the tools, and the JSON schema
 * of each tool's input.
 */
type Requests = {
  readonly prompts: Prompt.Prompt[];
  readonly tools: string[];
  readonly toolInputs: JsonSchema.JsonSchema[][];
  readonly notePrompts: Prompt.Prompt[];
};

type MethodLayer = Layer.Layer<ContextMethod, never, Models | Sessions | Notes>;

/** How reading the user's settings and folders can fail when an agent starts. */
type StartError = Layer.Error<typeof Settings.layer>;

type Harness = {
  /** The user's home folder; Tau's home is `.tau` in it. */
  readonly home: string;
  readonly directory: string;
  readonly prompts: Prompt.Prompt[];
  /** The tool descriptions of each model call. */
  readonly tools: string[];
  /** The JSON schema of each tool's input, in each model call. */
  readonly toolInputs: JsonSchema.JsonSchema[][];
  readonly notePrompts: Prompt.Prompt[];
  readonly startAgent: (
    replies: readonly Reply[],
  ) => Effect.Effect<Agent["Service"], StartError, Scope.Scope>;
  readonly startAgentUsing: (
    replies: readonly Reply[],
    method: MethodLayer,
    noteReplies?: readonly NoteReply[],
  ) => Effect.Effect<Agent["Service"], StartError, Scope.Scope>;
  readonly sessions: Sessions["Service"];
  readonly notes: Notes["Service"];
  /** The conditions the agents of the harness set, such as a skipped skill. */
  readonly status: Status["Service"];
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
      const requests: Requests = { prompts: [], tools: [], toolInputs: [], notePrompts: [] };
      const status = yield* Layer.build(Status.layer);

      // Settings are read when an agent starts, so a test can write settings.json first.
      const user = userInstructionsLayer.pipe(
        Layer.provide(Settings.layer),
        Layer.provide(tauHome),
        Layer.provide(BunServices.layer),
      );

      const startAgentUsing = (
        replies: readonly Reply[],
        method: MethodLayer,
        noteReplies: readonly NoteReply[] = [],
      ) =>
        Layer.build(
          Agent.layer.pipe(
            Layer.provide(method),
            Layer.provide(scriptedModels(replies, requests, noteReplies)),
            Layer.provide(Layer.succeedContext(store)),
            Layer.provide(BunServices.layer),
            Layer.provide(user),
            Layer.provide(
              favoriteModelsLayer.pipe(Layer.provide(tauHome), Layer.provide(BunServices.layer)),
            ),
            Layer.provide(Layer.succeed(OutputFolder, { directory: `${home}/output` })),
            Layer.provide(Layer.succeedContext(status)),
          ),
        ).pipe(Effect.map((context) => Context.get(context, Agent)));

      return yield* program({
        home,
        directory,
        ...requests,
        startAgent: (replies) => startAgentUsing(replies, ContextMethod.wholeHistory),
        startAgentUsing,
        sessions: Context.get(store, Sessions),
        notes: Context.get(store, Notes),
        status: Context.get(status, Status),
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
