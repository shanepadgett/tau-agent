import { describe, expect, test } from "bun:test";
import { BunServices } from "@effect/platform-bun";
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
import { AiError, LanguageModel, type Prompt, type Response } from "effect/ai";
import { TestClock } from "effect/testing";
import { Models } from "../../src/ai/Models.ts";
import { RouteId } from "../../src/ai/Routes.ts";
import { Agent, type OpenSession } from "../../src/core/Agent.ts";
import type { AgentEvent, RunOptions } from "../../src/core/Client.ts";
import { TauHome } from "../../src/database/TauHome.ts";
import { userInstructionsLayer } from "../../src/host/UserInstructions.ts";
import { Sessions } from "../../src/session/Sessions.ts";

type Reply = Stream.Stream<Response.StreamPartEncoded, AiError.AiError>;

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

/** The end of a reply, with the token counts a provider reports. */
const finish = (cacheRead: number, cacheWrite: number): Reply =>
  Stream.make<Response.StreamPartEncoded[]>({
    type: "finish",
    reason: "tool-calls",
    usage: {
      inputTokens: { uncached: 10, total: 10 + cacheRead + cacheWrite, cacheRead, cacheWrite },
      outputTokens: { total: 5, text: 5, reasoning: undefined },
    },
  });

/** A reply the provider refuses with a rate limit. */
const rateLimited: Reply = Stream.fail(
  AiError.make({
    module: "Scripted",
    method: "streamText",
    reason: new AiError.RateLimitError({}),
  }),
);

/** A reply that stops at the model's output limit. */
const cutOff: Reply = Stream.concat(
  textReply("The start of a long"),
  Stream.make<Response.StreamPartEncoded[]>({
    type: "finish",
    reason: "length",
    usage: {
      inputTokens: { uncached: 10, total: 10, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 5, text: 5, reasoning: undefined },
    },
  }),
);

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
  /** The user's home folder; Tau's home is `.tau` in it. */
  readonly home: string;
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

      const sessionsAt = Sessions.layer.pipe(Layer.provide(TauHome.at(`${home}/.tau`)));
      const sessions = Context.get(yield* Layer.build(sessionsAt), Sessions);
      const prompts: Prompt.Prompt[] = [];

      const startAgent = (replies: readonly Reply[]) =>
        Layer.build(
          Agent.layer.pipe(
            Layer.provide(scriptedModels(replies, prompts)),
            Layer.provide(Layer.succeed(Sessions, sessions)),
            Layer.provide(BunServices.layer),
            Layer.provide(userInstructionsLayer.pipe(Layer.provide(TauHome.at(`${home}/.tau`)))),
          ),
        ).pipe(Effect.map((context) => Context.get(context, Agent)));

      return yield* program({ home, directory, prompts, startAgent, sessions });
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
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
const prompt = Effect.fn("prompt")(function* (opened: OpenSession, text: string) {
  const events = yield* opened.subscribe;
  yield* opened.send({ type: "prompt", text, options });
  return yield* takeUntil(events, isRunEnd);
});

const runEnd = (events: readonly AgentEvent[]) => events.find(isRunEnd);

/** Sends a prompt and moves the test clock past each retry wait, through the run's end. */
const promptWithRetries = Effect.fn("promptWithRetries")(function* (
  opened: OpenSession,
  text: string,
) {
  const events = yield* opened.subscribe;
  yield* opened.send({ type: "prompt", text, options });
  const taken: AgentEvent[] = [];

  for (;;) {
    const event = yield* PubSub.take(events);
    taken.push(event);
    if (isRunEnd(event)) return taken;
    if (event.type === "retrying") yield* TestClock.adjust("1 minute");
  }
});

const retries = (events: readonly AgentEvent[]) =>
  events.flatMap((event) => (event.type === "retrying" ? [event] : []));

/** The text of every tool result in a prompt, in order. */
const toolResults = (sent: Prompt.Prompt | undefined) =>
  (sent?.content ?? []).flatMap((message) =>
    message.role === "tool"
      ? message.content.flatMap((part) =>
          part.type === "tool-result" ? [String(part.result)] : [],
        )
      : [],
  );

/** The roles of the messages that carry a Claude cache mark. */
const cacheMarked = (sent: Prompt.Prompt | undefined) =>
  (sent?.content ?? []).flatMap((message) =>
    message.options.anthropic?.cacheControl === undefined ? [] : [message.role],
  );

/** The messages as a provider gets them, without the cache marks, which move on each request. */
const withoutMarks = (sent: Prompt.Prompt | undefined) =>
  JSON.stringify((sent?.content ?? []).map(({ role, content }) => ({ role, content })));

const systemText = (sent: Prompt.Prompt | undefined) =>
  (sent?.content ?? []).flatMap((message) => (message.role === "system" ? [message.content] : []));

/** The text of every user message: prompts and instruction notes. */
const userTexts = (sent: Prompt.Prompt | undefined) =>
  (sent?.content ?? []).flatMap((message) =>
    message.role === "user"
      ? message.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
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

        const opened = yield* agent.open(Option.none(), harness.directory);
        const events = yield* prompt(opened, "Write a file.");

        expect(runEnd(events)).toEqual({ type: "run-ended", reason: "answered" });
        expect(events).toContainEqual({ type: "tool-ended", callId: "call-1", isFailure: false });
        expect(toolResults(harness.prompts[1])).toEqual(["hi\n"]);

        expect(yield* (yield* FileSystem.FileSystem).exists(`${harness.directory}/out.txt`)).toBe(
          true,
        );
      }),
    ));

  test("each request repeats the one before it and carries cache marks, and replies keep their token counts", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const agent = yield* harness.startAgent([
          Stream.concat(runReply("call-1", 'console.log("hi")'), finish(0, 900)),
          textReply("Done."),
        ]);

        const opened = yield* agent.open(Option.none(), harness.directory);
        yield* prompt(opened, "Say hi.");
        const [first, second] = harness.prompts;

        expect(withoutMarks(second)).toStartWith(withoutMarks(first).slice(0, -1));
        expect(cacheMarked(first)).toEqual(["system", "user"]);
        expect(cacheMarked(second)).toEqual(["system", "tool"]);

        const entries = yield* harness.sessions.entries(opened.session.id, 0);
        const reply = entries.find(({ body }) => body.type === "assistant")?.body;

        expect(reply?.type === "assistant" && reply.tokens).toEqual({
          input: 910,
          output: 5,
          cacheRead: 0,
          cacheWrite: 900,
        });
      }),
    ));

  test("instructions go in the system prompt once, and later changes come as notes", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        yield* fileSystem.makeDirectory(`${harness.home}/.agents`);
        yield* fileSystem.writeFileString(`${harness.home}/.agents/AGENTS.md`, "Be brief.");
        yield* fileSystem.writeFileString(`${harness.directory}/AGENTS.md`, "Use spaces.");

        const agent = yield* harness.startAgent([
          runReply(
            "call-1",
            'await tools.write({ path: "AGENTS.md", content: "Use tabs." })\nawait tools.write({ path: "new.txt", content: "x" })',
          ),
          textReply("Done."),
        ]);

        const opened = yield* agent.open(Option.none(), harness.directory);
        yield* prompt(opened, "Change the rules.");
        const [first, second] = harness.prompts;

        const [system] = systemText(first);
        expect(system).toContain("Be brief.");
        expect(system).toContain("Use spaces.");
        expect(system).toContain("Today's date is");
        expect(system).toContain("AGENTS.md");
        expect(systemText(second)).toEqual(systemText(first));

        const notes = userTexts(second).slice(1).join("\n");

        expect(notes).toContain(
          `${harness.directory}/AGENTS.md changed. It now says:\n\nUse tabs.`,
        );

        expect(notes).toContain("Files added:\nnew.txt");
      }),
    ));

  test("a file read in a folder with its own AGENTS.md adds that file as a note, once", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        yield* fileSystem.makeDirectory(`${harness.directory}/sub`);
        yield* fileSystem.writeFileString(`${harness.directory}/sub/AGENTS.md`, "Sub rules.");
        yield* fileSystem.writeFileString(`${harness.directory}/sub/file.txt`, "x");
        const read = 'await tools.read({ path: "sub/file.txt" })';

        const agent = yield* harness.startAgent([
          runReply("call-1", read),
          runReply("call-2", read),
          textReply("Done."),
        ]);

        const opened = yield* agent.open(Option.none(), harness.directory);
        yield* prompt(opened, "Read it.");
        const [first, , third] = harness.prompts;
        const note = `Instructions from ${harness.directory}/sub/AGENTS.md:\n\nSub rules.`;

        expect(systemText(first)[0]).not.toContain("Sub rules.");
        expect(userTexts(third).filter((text) => text === note)).toHaveLength(1);
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

        const opened = yield* agent.open(Option.none(), harness.directory);
        yield* prompt(opened, "Wait.");

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
        const reopened = yield* agent.open(Option.some(session.id), harness.directory);
        const events = yield* prompt(reopened, "Go on.");

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

        const opened = yield* agent.open(Option.none(), harness.directory);
        const events = yield* opened.subscribe;
        yield* opened.send({ type: "prompt", text: "Wait.", options });
        yield* takeUntil(events, (event) => event.type === "tool-started");
        yield* opened.send({ type: "cancel" });

        expect(runEnd(yield* takeUntil(events, isRunEnd))?.reason).toBe("cancelled");
        expect(Bun.spawnSync(["pgrep", "-f", "sleep 31.25"]).stdout.toString()).toBe("");

        yield* prompt(opened, "Go on.");
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

        const opened = yield* agent.open(Option.none(), harness.directory);
        const events = yield* opened.subscribe;
        yield* opened.send({ type: "prompt", text: "Answer.", options });
        yield* takeUntil(events, (event) => event.type === "text");
        yield* opened.send({ type: "cancel" });
        yield* takeUntil(events, isRunEnd);

        const entries = yield* harness.sessions.entries(opened.session.id, 0);

        expect(entries.map(({ body }) => body).at(-1)).toMatchObject({
          type: "assistant",
          interrupted: true,
        });

        yield* prompt(opened, "Again.");
        expect(texts(harness.prompts[1])).toEqual([]);
      }),
    ));

  test("a cancel stops the running prompt and gives back the waiting ones", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const agent = yield* harness.startAgent([
          runReply("call-1", 'await tools.sh({ command: "sleep 32.5" })'),
          textReply("Second answer."),
        ]);

        const opened = yield* agent.open(Option.none(), harness.directory);
        const events = yield* opened.subscribe;
        yield* opened.send({ type: "prompt", text: "Wait.", options });
        yield* opened.send({ type: "prompt", text: "Then this.", options });
        yield* takeUntil(events, (event) => event.type === "tool-started");
        yield* opened.send({ type: "cancel" });

        const afterCancel = yield* takeUntil(events, isRunEnd);
        expect(runEnd(afterCancel)?.reason).toBe("cancelled");
        expect(afterCancel).toContainEqual({ type: "prompts-returned", prompts: ["Then this."] });
        expect(Bun.spawnSync(["pgrep", "-f", "sleep 32.5"]).stdout.toString()).toBe("");

        const entries = yield* harness.sessions.entries(opened.session.id, 0);
        const userTexts = entries.flatMap(({ body }) => (body.type === "user" ? [body.text] : []));
        expect(userTexts).toEqual(["Wait."]);
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

        const opened = yield* agent.open(Option.none(), harness.directory);
        const subscription = yield* opened.subscribe;
        const limited = { ...options, maxTurns: 2 };
        yield* opened.send({ type: "prompt", text: "Loop.", options: limited });
        const events = yield* takeUntil(subscription, isRunEnd);

        expect(runEnd(events)).toEqual({ type: "run-ended", reason: "turn-limit" });
        expect(harness.prompts).toHaveLength(2);
      }),
    ));

  test("a rate limit is retried after a wait, and text from the failed call is left out", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const agent = yield* harness.startAgent([
          Stream.concat(unfinishedReply("Half").pipe(Stream.take(2)), rateLimited),
          rateLimited,
          textReply("Answer."),
        ]);

        const opened = yield* agent.open(Option.none(), harness.directory);
        const events = yield* promptWithRetries(opened, "Answer.");

        expect(runEnd(events)).toEqual({ type: "run-ended", reason: "answered" });
        expect(retries(events).map(({ attempt }) => attempt)).toEqual([1, 2]);
        // The waits are 2 and 4 seconds, give or take a fifth.
        expect(retries(events)[0]?.seconds).toBe(2);
        expect(retries(events)[1]?.seconds).toBeWithin(3, 6);
        expect(texts(harness.prompts[2])).toEqual([]);

        const entries = yield* harness.sessions.entries(opened.session.id, 0);

        const interrupted = entries.filter(
          ({ body }) => body.type === "assistant" && body.interrupted,
        );

        expect(interrupted).toHaveLength(1);
      }).pipe(Effect.provide(TestClock.layer())),
    ));

  test("after four retries the run fails", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const agent = yield* harness.startAgent(Array.from({ length: 5 }, () => rateLimited));
        const opened = yield* agent.open(Option.none(), harness.directory);
        const events = yield* promptWithRetries(opened, "Answer.");

        expect(retries(events)).toHaveLength(4);
        expect(runEnd(events)).toMatchObject({ type: "run-ended", reason: "failed" });
        expect(harness.prompts).toHaveLength(5);
      }).pipe(Effect.provide(TestClock.layer())),
    ));

  test("a reply cut off at the output limit ends the run as output-limit", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const agent = yield* harness.startAgent([cutOff]);
        const opened = yield* agent.open(Option.none(), harness.directory);
        const events = yield* prompt(opened, "Write a lot.");

        expect(runEnd(events)).toEqual({ type: "run-ended", reason: "output-limit" });
      }),
    ));

  test("a new agent continues a session by ID with its earlier runs", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const first = yield* harness.startAgent([textReply("First answer.")]);
        const opened = yield* first.open(Option.none(), harness.directory);
        yield* prompt(opened, "First.");

        const second = yield* harness.startAgent([
          textReply("unused"),
          textReply("Second answer."),
        ]);

        const reopened = yield* second.open(Option.some(opened.session.id), harness.directory);
        yield* prompt(reopened, "Second.");

        expect(texts(harness.prompts[1])).toEqual(["First answer."]);
      }),
    ));
});
