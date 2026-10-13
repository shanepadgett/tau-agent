import { describe, expect, test } from "bun:test";
import { BunCrypto, BunFileSystem } from "@effect/platform-bun";
import {
  Context,
  Duration,
  Effect,
  FileSystem,
  Layer,
  Option,
  PubSub,
  type Scope,
  Stream,
} from "effect";
import { LanguageModel, type Prompt, type Response } from "effect/ai";
import { Models } from "../src/ai/models.ts";
import { RouteId } from "../src/ai/routes.ts";
import { Agent, agentLayer, type RunOptions } from "../src/core/agent.ts";
import type { AgentEvent } from "../src/core/client.ts";
import type { SessionId } from "../src/session/entry.ts";
import { Sessions, sessionsLayer } from "../src/session/sessions.ts";

type Reply = Stream.Stream<Response.StreamPartEncoded>;

const options: RunOptions = {
  model: { route: RouteId.make("scripted"), model: "scripted" },
  maxTurns: undefined,
  timeouts: { run: Duration.seconds(5), shell: Duration.seconds(5) },
};

const textReply = (text: string): Reply =>
  Stream.make<Response.StreamPartEncoded[]>(
    { type: "text-start", id: "text" },
    { type: "text-delta", id: "text", delta: text },
    { type: "text-end", id: "text" },
  );

const runReply = (id: string, code: string): Reply =>
  Stream.make<Response.StreamPartEncoded[]>({
    type: "tool-call",
    id,
    name: "run",
    params: { code },
  });

/** A reply that sends some text and then never ends, as a model does while it is still writing. */
const unfinishedReply = (text: string): Reply =>
  Stream.concat(
    Stream.make<Response.StreamPartEncoded[]>(
      { type: "text-start", id: "text" },
      { type: "text-delta", id: "text", delta: text },
    ),
    Stream.never,
  );

/** A model that answers with the next scripted reply and keeps each prompt it gets. */
const scriptedModels = (replies: readonly Reply[], prompts: Prompt.Prompt[]) =>
  Layer.effect(
    Models,
    Effect.gen(function* () {
      const model = yield* LanguageModel.make({
        generateText: () => Effect.die("Tau streams every model call."),
        streamText: (request) => {
          const reply = replies[prompts.length] ?? textReply("No more script.");
          prompts.push(request.prompt);
          return reply;
        },
      });

      return Models.of({
        languageModel: () => Effect.succeed(model),
        decisionModel: () => Effect.die("Turn tests use no decision model."),
      });
    }),
  );

type Harness = {
  readonly directory: string;
  readonly prompts: Prompt.Prompt[];
  readonly startAgent: (
    replies: readonly Reply[],
  ) => Effect.Effect<Agent["Service"], never, Scope.Scope>;
  readonly sessions: Sessions["Service"];
};

/** Real SQLite, codemode and shell in a temp directory. Each `startAgent` builds a new agent on the same files. */
const withHarness = <A, E>(
  program: (harness: Harness) => Effect.Effect<A, E, Scope.Scope | FileSystem.FileSystem>,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const home = yield* fileSystem.makeTempDirectoryScoped();
      const directory = `${home}/work`;
      yield* fileSystem.makeDirectory(directory);

      const storage = Layer.mergeAll(BunFileSystem.layer, BunCrypto.layer);
      const sessionsAt = sessionsLayer(`${home}/.tau`).pipe(Layer.provide(storage));
      const sessions = Context.get(yield* Layer.build(sessionsAt), Sessions);
      const prompts: Prompt.Prompt[] = [];

      const startAgent = (replies: readonly Reply[]) =>
        Layer.build(
          agentLayer.pipe(
            Layer.provide(scriptedModels(replies, prompts)),
            Layer.provide(Layer.succeed(Sessions, sessions)),
            Layer.provide(BunFileSystem.layer),
          ),
        ).pipe(Effect.map((context) => Context.get(context, Agent)));

      return yield* program({ directory, prompts, startAgent, sessions });
    }).pipe(Effect.scoped, Effect.provide(BunFileSystem.layer)),
  );

/** Takes events until one matches, and gives every event taken. */
const takeUntil = Effect.fn("takeUntil")(function* (
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

const isRunEnd = (event: AgentEvent) => event.type === "run-ended";

/** Sends a prompt and gives the run's events, through its end. */
const prompt = Effect.fn("prompt")(function* (
  agent: Agent["Service"],
  session: SessionId,
  text: string,
) {
  const events = yield* agent.subscribe(session);
  yield* agent.send(session, { type: "prompt", text });
  return yield* takeUntil(events, isRunEnd);
});

const runEnd = (events: readonly AgentEvent[]) => events.find(isRunEnd);

/** The text of every tool result in a prompt, in order. */
const toolResults = (sent: Prompt.Prompt | undefined) =>
  (sent?.content ?? []).flatMap((message) =>
    message.role === "tool"
      ? message.content.flatMap((part) =>
          part.type === "tool-result" ? [String(part.result)] : [],
        )
      : [],
  );

const texts = (sent: Prompt.Prompt | undefined) =>
  (sent?.content ?? []).flatMap((message) =>
    message.role === "assistant"
      ? message.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
      : [],
  );

describe("agent loop", () => {
  test("a run call runs its script in the session directory, and the next model call holds the result", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const agent = yield* harness.startAgent([
          runReply(
            "call-1",
            'const shell = await tools.sh({ command: "echo hi > out.txt && cat out.txt" })\nconsole.log(shell.output)',
          ),
          textReply("Done."),
        ]);

        const session = yield* agent.open(Option.none(), harness.directory, options);
        const events = yield* prompt(agent, session.id, "Write a file.");

        expect(runEnd(events)).toEqual({ type: "run-ended", reason: "answered" });
        expect(events).toContainEqual({ type: "tool-ended", callId: "call-1", isFailure: false });
        expect(toolResults(harness.prompts[1])).toEqual(["hi\n"]);

        expect(yield* (yield* FileSystem.FileSystem).exists(`${harness.directory}/out.txt`)).toBe(
          true,
        );
      }),
    ));

  test("a shell command past its timeout throws an error the script can catch", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const agent = yield* harness.startAgent([
          runReply(
            "call-1",
            'try { await tools.sh({ command: "echo started; sleep 5", timeoutSeconds: 0.2 }) } catch (error) { console.log(`caught: ${error.message}`) }',
          ),
          textReply("Done."),
        ]);

        const session = yield* agent.open(Option.none(), harness.directory, options);
        yield* prompt(agent, session.id, "Wait.");

        const [result] = toolResults(harness.prompts[1]);
        expect(result).toContain("caught: The command did not finish in 0.2 seconds");
        expect(result).toContain("started");
      }),
    ));

  test("a call that started and has no result is never run again", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const session = yield* harness.sessions.create(harness.directory);

        // What a crash leaves: the call was saved as started, and its result was never saved.
        yield* harness.sessions.append(session.id, [
          { type: "user", text: "Make a file." },
          {
            type: "assistant",
            model: options.model,
            parts: [
              {
                type: "tool-call",
                id: "call-1",
                name: "run",
                params: { code: 'await tools.write({ path: "again.txt", content: "x" })' },
                providerData: {},
              },
            ],
            interrupted: false,
          },
          { type: "tool-started", callId: "call-1" },
        ]);

        const agent = yield* harness.startAgent([textReply("It was interrupted.")]);
        yield* agent.open(Option.some(session.id), harness.directory, options);
        const events = yield* prompt(agent, session.id, "Go on.");

        expect(runEnd(events)?.type).toBe("run-ended");
        expect(toolResults(harness.prompts[0])[0]).toContain("Interrupted before it finished");

        expect(yield* (yield* FileSystem.FileSystem).exists(`${harness.directory}/again.txt`)).toBe(
          false,
        );
      }),
    ));

  test("cancelling a running command kills it, and the session can continue", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const agent = yield* harness.startAgent([
          runReply("call-1", 'await tools.sh({ command: "sleep 31.25" })'),
          textReply("Stopped."),
        ]);

        const session = yield* agent.open(Option.none(), harness.directory, options);
        const events = yield* agent.subscribe(session.id);
        yield* agent.send(session.id, { type: "prompt", text: "Wait." });
        yield* takeUntil(events, (event) => event.type === "tool-started");
        yield* agent.send(session.id, { type: "cancel" });

        expect(runEnd(yield* takeUntil(events, isRunEnd))?.reason).toBe("cancelled");
        expect(Bun.spawnSync(["pgrep", "-f", "sleep 31.25"]).stdout.toString()).toBe("");

        yield* prompt(agent, session.id, "Go on.");
        expect(toolResults(harness.prompts[1])).toEqual(["Interrupted by the user."]);
      }),
    ));

  test("a reply cut short is saved for the user and left out of later model calls", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const agent = yield* harness.startAgent([
          unfinishedReply("Half an ans"),
          textReply("Whole answer."),
        ]);

        const session = yield* agent.open(Option.none(), harness.directory, options);
        const events = yield* agent.subscribe(session.id);
        yield* agent.send(session.id, { type: "prompt", text: "Answer." });
        yield* takeUntil(events, (event) => event.type === "text");
        yield* agent.send(session.id, { type: "cancel" });
        yield* takeUntil(events, isRunEnd);

        const entries = yield* harness.sessions.entries(session.id, 0);

        expect(entries.map(({ body }) => body).at(-1)).toMatchObject({
          type: "assistant",
          interrupted: true,
        });

        yield* prompt(agent, session.id, "Again.");
        expect(texts(harness.prompts[1])).toEqual([]);
      }),
    ));

  test("with maxTurns set, a model that keeps calling tools stops at the limit", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const agent = yield* harness.startAgent([
          runReply("call-1", "1"),
          runReply("call-2", "2"),
          runReply("call-3", "3"),
        ]);

        const session = yield* agent.open(Option.none(), harness.directory, {
          ...options,
          maxTurns: 2,
        });

        const events = yield* prompt(agent, session.id, "Loop.");

        expect(runEnd(events)).toEqual({ type: "run-ended", reason: "turn-limit" });
        expect(harness.prompts).toHaveLength(2);
      }),
    ));

  test("a new agent continues a session by ID with its earlier runs", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const first = yield* harness.startAgent([textReply("First answer.")]);
        const session = yield* first.open(Option.none(), harness.directory, options);
        yield* prompt(first, session.id, "First.");

        const second = yield* harness.startAgent([
          textReply("unused"),
          textReply("Second answer."),
        ]);

        yield* second.open(Option.some(session.id), harness.directory, options);
        yield* prompt(second, session.id, "Second.");

        expect(texts(harness.prompts[1])).toEqual(["First answer."]);
      }),
    ));
});
