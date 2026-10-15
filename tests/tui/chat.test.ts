import { describe, expect, spyOn, test } from "bun:test";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import {
  Context,
  Deferred,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Queue,
  Schema,
  Stream,
} from "effect";
import type { Response } from "effect/ai";
import { ProviderId } from "../../src/ai/Providers.ts";
import type { Agent, OpenSession } from "../../src/core/Agent.ts";
import { Status } from "../../src/core/Status.ts";
import {
  type ChatAgent,
  type ChatOptions,
  type ChatSetup,
  type RestartLink,
  runTui,
} from "../../src/tui/Tui.ts";
import { options, prompt, runReply, textReply, withHarness } from "../support/agent-harness.ts";

/** The end of a reply that sent 42,000 tokens and got 500 back. */
const finish = Stream.make<Response.StreamPartEncoded[]>({
  type: "finish",
  reason: "stop",
  usage: {
    inputTokens: { uncached: 42000, total: 42000, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 500, text: 500, reasoning: undefined },
  },
});

const HEIGHT = 24;

/** Wide enough for a docked sidebar. */
const WIDE = 140;

const testTerminal = (width: number) =>
  Effect.acquireRelease(
    Effect.promise(() => createTestRenderer({ width, height: HEIGHT, kittyKeyboard: true })),
    (setup) => Effect.sync(() => setup.renderer.destroy()),
  );

/** A supervisor that never restarts the chat. */
const noRestarts: RestartLink = {
  draft: "",
  reportActivity: () => Effect.void,
  requestRestart: Effect.void,
  exitRequested: Effect.never,
  attention: undefined,
  holdAttention: () => Effect.void,
  deliveries: Stream.empty,
};

/** What the chat gets: everything but the agent, which `startChat` adds. */
type TestSetup = Omit<ChatSetup, "agent">;

const withoutRestarts = (chatOptions: ChatOptions): TestSetup => ({
  options: chatOptions,
  notifications: { enabled: false, sound: false },
  prompt: undefined,
  link: noRestarts,
});

/**
 * A supervisor that the test drives: it records what the chat reports and asks the chat to end. Its
 * draft is the unsent input of the chat before.
 */
const fakeSupervisor = Effect.fn("fakeSupervisor")(function* (draft: string) {
  const exitRequested = yield* Deferred.make<void>();
  const reports: string[] = [];

  const link: RestartLink = {
    draft,
    reportActivity: (activity) => Effect.sync(() => reports.push(activity)),
    requestRestart: Effect.sync(() => reports.push("restart-request")),
    exitRequested: Deferred.await(exitRequested),
    attention: undefined,
    holdAttention: () => Effect.void,
    deliveries: Stream.empty,
  };

  return { link, exitRequested, reports };
});

/** A supervisor that has no new code, so it sends every held attention straight back. */
const echoingSupervisor = Effect.fn("echoingSupervisor")(function* () {
  const held = yield* Queue.unbounded<string>();

  const link: RestartLink = {
    ...noRestarts,
    holdAttention: (message) => Queue.offer(held, message).pipe(Effect.asVoid),
    deliveries: Stream.fromQueue(held),
  };

  return link;
});

/**
 * Starts the chat on a test terminal `width` columns wide, with a status the test can set
 * conditions in. The chat stops when the test's scope closes.
 */
const startChat = Effect.fn("startChat")(function* (
  agent: Agent["Service"],
  opened: OpenSession,
  setup: TestSetup,
  width = 80,
) {
  const terminal = yield* testTerminal(width);
  const services = yield* Layer.build(Status.layer);

  const chatAgent: ChatAgent = {
    open: (session) =>
      agent.open(Option.fromUndefinedOr(session), opened.session.directory).pipe(Effect.orDie),
    sessions: agent.sessions,
    models: agent.models,
    favoriteModels: agent.favoriteModels,
    toggleFavoriteModel: agent.toggleFavoriteModel,
    sidebarChoice: agent.sidebarChoice,
    saveSidebarChoice: agent.saveSidebarChoice,
  };

  const tui = runTui(terminal.renderer, opened, { ...setup, agent: chatAgent }).pipe(
    Effect.provideContext(services),
  );

  const chat = yield* Effect.forkScoped(tui);

  yield* frameWith(terminal, "ctrl+d quit");
  return { terminal, chat, status: Context.get(services, Status) };
});

const MODELS = [
  {
    ref: { provider: ProviderId.make("openai"), model: "gpt-6" },
    name: "GPT-6",
    contextTokens: 400_000,
    thinking: ["off", "low", "medium", "high", "xhigh", "max"] as const,
  },
  {
    ref: { provider: ProviderId.make("anthropic"), model: "claude-sonnet-5-5" },
    name: "Claude Sonnet 5.5",
    contextTokens: 1_000_000,
    thinking: ["off", "low", "medium", "high", "xhigh", "max"] as const,
  },
  {
    ref: { provider: ProviderId.make("anthropic"), model: "claude-opus-5" },
    name: "Claude Opus 5",
    contextTokens: 200_000,
    thinking: ["low", "high"] as const,
  },
];

/** The line between the favorite models and the rest, inside the picker's border. */
const DIVIDER = /│─{20,}│/;

const SavedJson = Schema.fromJsonString(Schema.Array(Schema.String));

/** The saved favorites, once the background save has written them. */
const savedFavorites = Effect.fn("savedFavorites")(function* (home: string) {
  const fileSystem = yield* FileSystem.FileSystem;

  for (;;) {
    const text = yield* fileSystem
      .readFileString(`${home}/.tau/favorites.json`)
      .pipe(Effect.orElseSucceed(() => ""));

    if (text !== "") return yield* Schema.decodeEffect(SavedJson)(text);
    yield* Effect.sleep("10 millis");
  }
});

const SavedTuiJson = Schema.fromJsonString(Schema.Struct({ sidebar: Schema.String }));

/** What the chat remembers, once the background save has written it. */
const savedTuiMemory = Effect.fn("savedTuiMemory")(function* (home: string) {
  const fileSystem = yield* FileSystem.FileSystem;

  for (;;) {
    const text = yield* fileSystem
      .readFileString(`${home}/.tau/tui.json`)
      .pipe(Effect.orElseSucceed(() => ""));

    if (text !== "") return yield* Schema.decodeEffect(SavedTuiJson)(text);
    yield* Effect.sleep("10 millis");
  }
});

/** Waits for a frame that shows `text`. */
const frameWith = (terminal: TestRendererSetup, text: string) =>
  frameWhere(terminal, (frame) => frame.includes(text));

/**
 * Waits for a frame that `isWanted`. The renderer draws a frame by itself after each change, such
 * as a new event in the chat or Markdown that its highlighter finished.
 */
const frameWhere = (terminal: TestRendererSetup, isWanted: (frame: string) => boolean) =>
  Effect.callback<string>((resume) => {
    const check = () => {
      const frame = terminal.captureCharFrame();
      if (!isWanted(frame)) return;
      terminal.renderer.off("frame", check);
      resume(Effect.succeed(frame));
    };

    terminal.renderer.on("frame", check);
    check();
    return Effect.sync(() => terminal.renderer.off("frame", check));
  });

describe("the chat in the terminal", () => {
  test("a completed live turn requests a notification through the renderer", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const agent = yield* harness.startAgent([textReply("Notification answer.")]);
        const opened = yield* agent.open(Option.none(), harness.directory);

        const { terminal } = yield* startChat(agent, opened, {
          ...withoutRestarts(options),
          link: yield* echoingSupervisor(),
          notifications: { enabled: true, sound: false },
        });

        const delivered = yield* Deferred.make<void>();

        const banner = spyOn(terminal.renderer, "triggerNotification").mockImplementation(() => {
          Deferred.doneUnsafe(delivered, Effect.void);
          return true;
        });

        terminal.renderer.emit("blur");
        yield* Effect.promise(() => terminal.mockInput.typeText("Answer this."));
        terminal.mockInput.pressEnter();
        yield* Deferred.await(delivered);
        expect(banner.mock.calls).toEqual([["Response ready", "Tau"]]);
        expect(yield* frameWith(terminal, "Notification answer.")).toContain("Answer this.");
      }).pipe(Effect.scoped),
    ));

  test("a sent prompt shows with its tool calls and answer", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const agent = yield* harness.startAgent([
          runReply("call-1", `console.log("hi");`),
          textReply("All done."),
        ]);

        const opened = yield* agent.open(Option.none(), harness.directory);
        const { terminal } = yield* startChat(agent, opened, withoutRestarts(options));

        yield* Effect.promise(() => terminal.mockInput.typeText("Say hi."));
        terminal.mockInput.pressEnter();
        const frame = yield* frameWith(terminal, "All done.");

        expect(frame).toContain("Say hi.");
        expect(frame).toContain("✓ run");
      }).pipe(Effect.scoped),
    ));

  test("a resumed session shows its past prompts and answers", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const agent = yield* harness.startAgent([textReply("Earlier answer.")]);
        const opened = yield* agent.open(Option.none(), harness.directory);
        yield* prompt(opened, "Earlier prompt.");

        const { terminal } = yield* startChat(agent, opened, withoutRestarts(options));
        const frame = yield* frameWith(terminal, "Earlier answer.");

        expect(frame).toContain("Earlier prompt.");
      }).pipe(Effect.scoped),
    ));

  test("an answer shows as Markdown, without its marks", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const answer = [
          "# Plan",
          "Run `bun test` first.",
          "| name | size |\n| --- | --- |\n| one | 1 |",
          "```ts",
          "const done = true;",
          "```",
        ].join("\n\n");

        const agent = yield* harness.startAgent([textReply(answer)]);
        const opened = yield* agent.open(Option.none(), harness.directory);
        const { terminal } = yield* startChat(agent, opened, withoutRestarts(options));

        yield* Effect.promise(() => terminal.mockInput.typeText("Plan it."));
        terminal.mockInput.pressEnter();
        // Each top-level block draws once its highlighter is done, so the blocks appear one by one.
        const shown = ["Plan", "bun test", "name", "const done = true;"];

        const frame = yield* frameWhere(terminal, (now) =>
          shown.every((text) => now.includes(text)),
        );

        expect(frame).toContain("Plan");
        expect(frame).not.toContain("# Plan");
        expect(frame).toContain("Run bun test first.");
        expect(frame).toMatch(/│ name +│ size +│/);
        expect(frame).not.toContain("```");
      }).pipe(Effect.scoped),
    ));

  test("Enter during a run steers it, and the run takes the message", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const agent = yield* harness.startAgent([
          runReply("call-1", 'await tools.sh({ command: "sleep 0.5" })'),
          textReply("Done, in Python."),
        ]);

        const opened = yield* agent.open(Option.none(), harness.directory);
        const { terminal } = yield* startChat(agent, opened, withoutRestarts(options));

        yield* Effect.promise(() => terminal.mockInput.typeText("Write it."));
        terminal.mockInput.pressEnter();
        yield* frameWith(terminal, "enter steer · tab queue · esc cancel");
        yield* Effect.promise(() => terminal.mockInput.typeText("Use Python."));
        terminal.mockInput.pressEnter();
        const frame = yield* frameWith(terminal, "Done, in Python.");

        expect(frame).toMatch(/Use Python\.[\s\S]*Done, in Python\./);
        expect(frame).not.toContain("Steering:");
      }).pipe(Effect.scoped),
    ));

  test("on a wide terminal the docked sidebar shows context and cost; Ctrl-B hides it and Tau remembers", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const agent = yield* harness.startAgent([Stream.concat(textReply("Hello."), finish)]);
        const opened = yield* agent.open(Option.none(), harness.directory);
        const { terminal } = yield* startChat(agent, opened, withoutRestarts(options), WIDE);
        expect(yield* frameWith(terminal, "Session")).toContain("No model call yet");

        yield* Effect.promise(() => terminal.mockInput.typeText("Hi."));
        terminal.mockInput.pressEnter();
        const frame = yield* frameWith(terminal, "$0.04");

        expect(frame).toContain("43k / 128k");
        expect(frame).toContain("ctrl+b sidebar");
        expect(frame).not.toContain("43k/128k");

        terminal.mockInput.pressKey("b", { ctrl: true });
        yield* frameWhere(terminal, (shown) => !shown.includes("Session"));
        expect(yield* savedTuiMemory(harness.home)).toEqual({ sidebar: "closed" });
      }).pipe(Effect.scoped),
    ));

  test("the sidebar lists the commands the agent started, and says when nothing is compacted", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const agent = yield* harness.startAgent([
          runReply("call-1", 'await tools.process.start({ command: "sleep 30" });'),
          finish,
        ]);

        const opened = yield* agent.open(Option.none(), harness.directory);
        const { terminal } = yield* startChat(agent, opened, withoutRestarts(options), WIDE);
        const empty = yield* frameWith(terminal, "None started");
        expect(empty).toContain("No notes yet");
        expect(empty).toContain("Not compacted yet");

        yield* Effect.promise(() => terminal.mockInput.typeText("Start it."));
        terminal.mockInput.pressEnter();
        expect(yield* frameWith(terminal, "● sleep 30")).toMatch(/● sleep 30 +running/);
      }).pipe(Effect.scoped),
    ));

  test("on a narrow terminal Ctrl-B opens the sidebar as a drawer, and Escape closes it", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const agent = yield* harness.startAgent([]);
        const opened = yield* agent.open(Option.none(), harness.directory);
        const { terminal } = yield* startChat(agent, opened, withoutRestarts(options));
        expect(terminal.captureCharFrame()).not.toContain("Session");

        terminal.mockInput.pressKey("b", { ctrl: true });
        yield* frameWith(terminal, "No model call yet");
        terminal.mockInput.pressEscape();
        yield* frameWhere(terminal, (frame) => !frame.includes("Session"));
      }).pipe(Effect.scoped),
    ));

  test("a narrower terminal closes the docked sidebar, and a wider one opens it again", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const agent = yield* harness.startAgent([]);
        const opened = yield* agent.open(Option.none(), harness.directory);
        const { terminal } = yield* startChat(agent, opened, withoutRestarts(options), WIDE);
        yield* frameWith(terminal, "Session");

        terminal.resize(100, HEIGHT);
        yield* frameWhere(terminal, (frame) => !frame.includes("Session"));
        terminal.resize(WIDE, HEIGHT);
        yield* frameWith(terminal, "Session");
      }).pipe(Effect.scoped),
    ));

  test("Shift-Enter adds a line, and Ctrl-D quits", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const agent = yield* harness.startAgent([]);
        const opened = yield* agent.open(Option.none(), harness.directory);
        const { terminal, chat } = yield* startChat(agent, opened, withoutRestarts(options));

        yield* Effect.promise(() => terminal.mockInput.typeText("one"));
        terminal.mockInput.pressEnter({ shift: true });
        yield* Effect.promise(() => terminal.mockInput.typeText("two"));
        const frame = yield* frameWith(terminal, "two");

        expect(frame).toMatch(/one\s*│?\s*\n.*two/);
        terminal.mockInput.pressKey("d", { ctrl: true });
        expect(yield* Fiber.join(chat)).toEqual({ reason: "quit", session: opened.session.id });
      }).pipe(Effect.scoped),
    ));

  test("/commit takes the text after it, and outside a git repository it says so and sends nothing", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const agent = yield* harness.startAgent([textReply("Not called.")]);
        const opened = yield* agent.open(Option.none(), harness.directory);
        const { terminal } = yield* startChat(agent, opened, withoutRestarts(options));

        yield* Effect.promise(() => terminal.mockInput.typeText("/commit make it one commit"));
        terminal.mockInput.pressEnter();
        const frame = yield* frameWith(terminal, "Not in a git repository.");

        expect(frame).not.toContain("Not called.");
      }).pipe(Effect.scoped),
    ));

  test("without a model, the chat opens and a sent prompt goes back with how to set one", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const agent = yield* harness.startAgent([]);
        const opened = yield* agent.open(Option.none(), harness.directory);

        const { terminal } = yield* startChat(
          agent,
          opened,
          withoutRestarts({ ...options, model: undefined }),
        );

        yield* Effect.promise(() => terminal.mockInput.typeText("Say hi."));
        terminal.mockInput.pressEnter();
        const frame = yield* frameWith(terminal, "No model is set.");

        expect(frame).toContain("no model set");
        // Only the editor can show it: a prompt that was not sent does not enter the transcript.
        expect(frame).toContain("Say hi.");
      }).pipe(Effect.scoped),
    ));

  test("a restart ends the chat with its unsent input, and the next chat starts with it", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const agent = yield* harness.startAgent([]);
        const opened = yield* agent.open(Option.none(), harness.directory);
        const supervisor = yield* fakeSupervisor("carried over");
        const setup = { ...withoutRestarts(options), link: supervisor.link };
        const { terminal, chat } = yield* startChat(agent, opened, setup);

        yield* Effect.promise(() => terminal.mockInput.typeText(" and more"));
        yield* frameWith(terminal, "carried over and more");
        yield* Deferred.succeed(supervisor.exitRequested, undefined);

        expect(yield* Fiber.join(chat)).toEqual({
          reason: "restart",
          draft: "carried over and more",
          session: opened.session.id,
        });
      }).pipe(Effect.scoped),
    ));

  test("the chat reports when it is idle and takes /restart, with only the model and keys under the input", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const agent = yield* harness.startAgent([textReply("Hello.")]);
        const opened = yield* agent.open(Option.none(), harness.directory);
        const supervisor = yield* fakeSupervisor("");
        const setup = { ...withoutRestarts(options), link: supervisor.link };
        const { terminal } = yield* startChat(agent, opened, setup);

        yield* Effect.promise(() => terminal.mockInput.typeText("Hi."));
        terminal.mockInput.pressEnter();
        yield* frameWith(terminal, "Hello.");
        yield* Effect.promise(() => terminal.mockInput.typeText("/restart"));
        terminal.mockInput.pressEnter();
        const requested = () => supervisor.reports.includes("restart-request");
        yield* Effect.yieldNow.pipe(Effect.repeat({ until: requested }));
        yield* frameWith(terminal, "enter send · shift+enter new line · ctrl+d quit");

        expect(supervisor.reports).toEqual(["idle", "busy", "idle", "restart-request"]);
      }).pipe(Effect.scoped),
    ));

  test("/restart during a run says that Tau restarts when the run ends", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const agent = yield* harness.startAgent([Stream.never]);
        const opened = yield* agent.open(Option.none(), harness.directory);
        const supervisor = yield* fakeSupervisor("");
        const setup = { ...withoutRestarts(options), link: supervisor.link };
        const { terminal } = yield* startChat(agent, opened, setup);

        yield* Effect.promise(() => terminal.mockInput.typeText("Hi."));
        terminal.mockInput.pressEnter();
        yield* frameWith(terminal, "esc cancel");
        yield* Effect.promise(() => terminal.mockInput.typeText("/restart"));
        terminal.mockInput.pressEnter();
        yield* frameWith(terminal, "Tau restarts when this run ends.");

        expect(supervisor.reports).toContain("restart-request");
      }).pipe(Effect.scoped),
    ));

  test("typing a command lists the matching ones, and Enter runs the chosen one", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const agent = yield* harness.startAgent([]);
        const opened = yield* agent.open(Option.none(), harness.directory);
        const { terminal } = yield* startChat(agent, opened, withoutRestarts(options));

        yield* Effect.promise(() => terminal.mockInput.typeText("/se"));
        const listed = yield* frameWith(terminal, "▸ /sessions");

        expect(listed).toContain("Open an earlier session of this folder");
        expect(listed).not.toContain("/model");
        expect(listed).toContain("tab complete · enter select · esc close");
        terminal.mockInput.pressEnter();
        yield* frameWith(terminal, "Type to filter");
      }).pipe(Effect.scoped),
    ));

  test("/model lists models by name and provider; Ctrl+F moves one above a divider and saves it", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const agent = yield* harness.startAgent([]);
        const opened = yield* agent.open(Option.none(), harness.directory);
        const models = Effect.succeed(MODELS);

        const { terminal } = yield* startChat(
          { ...agent, models },
          opened,
          withoutRestarts(options),
        );

        yield* Effect.promise(() => terminal.mockInput.typeText("/model"));
        terminal.mockInput.pressEnter();
        const listed = yield* frameWith(terminal, "ctrl+f pin");

        expect(listed).toMatch(
          /Claude Opus 5 \(anthropic\)[^\n]*\n[^\n]*Claude Sonnet 5\.5 \(anthropic\)/,
        );

        expect(listed).not.toMatch(DIVIDER);
        terminal.mockInput.pressArrow("down");
        terminal.mockInput.pressKey("f", { ctrl: true });

        const pinned = yield* frameWhere(terminal, (frame) =>
          /Claude Sonnet 5\.5 \(anthropic\)[^\n]*\n[^\n]*─{20,}[^\n]*\n[^\n]*Claude Opus 5/.test(
            frame,
          ),
        );

        expect(pinned).toContain("GPT-6 (openai)");
        expect(yield* savedFavorites(harness.home)).toEqual(["anthropic/claude-sonnet-5-5"]);
        yield* Effect.promise(() => terminal.mockInput.typeText("gpt"));
        const filtered = yield* frameWhere(terminal, (frame) => !frame.includes("Claude"));

        expect(filtered).toContain("GPT-6 (openai)");
        expect(filtered).not.toMatch(DIVIDER);
      }).pipe(Effect.scoped),
    ));

  test("Shift+Tab steps the thinking level the footer shows, and the next reply saves it", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const agent = yield* harness.startAgent([textReply("Thought.")]);
        const opened = yield* agent.open(Option.none(), harness.directory);

        const scripted = {
          ref: options.model,
          name: "Scripted",
          contextTokens: 128_000,
          thinking: ["low", "medium", "high"] as const,
        };

        const { terminal } = yield* startChat(
          { ...agent, models: Effect.succeed([scripted]) },
          opened,
          withoutRestarts(options),
        );

        const first = yield* frameWith(terminal, "scripted/scripted (medium)");
        expect(first).toContain("shift+tab");
        terminal.mockInput.pressKey("\t", { shift: true });
        yield* frameWith(terminal, "scripted/scripted (high)");
        terminal.mockInput.pressKey("\t", { shift: true });
        yield* frameWith(terminal, "scripted/scripted (low)");

        yield* Effect.promise(() => terminal.mockInput.typeText("Think."));
        terminal.mockInput.pressEnter();
        yield* frameWith(terminal, "Thought.");

        expect((yield* opened.lastModel)?.thinking).toBe("low");
      }).pipe(Effect.scoped),
    ));

  test("Escape closes the command list during a run without cancelling the run", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const agent = yield* harness.startAgent([Stream.never]);
        const opened = yield* agent.open(Option.none(), harness.directory);
        const { terminal } = yield* startChat(agent, opened, withoutRestarts(options));

        yield* Effect.promise(() => terminal.mockInput.typeText("Hi."));
        terminal.mockInput.pressEnter();
        yield* frameWith(terminal, "esc cancel");
        yield* Effect.promise(() => terminal.mockInput.typeText("/re"));
        yield* frameWith(terminal, "▸ /restart");
        terminal.mockInput.pressEscape();
        const frame = yield* frameWith(terminal, "esc cancel");

        expect(frame).toContain("Running");
        expect(frame).not.toContain("Commands");
      }).pipe(Effect.scoped),
    ));

  test("each Ctrl-C closes the command list, then clears the input, then cancels the run, then quits", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const agent = yield* harness.startAgent([Stream.never]);
        const opened = yield* agent.open(Option.none(), harness.directory);
        const { terminal, chat } = yield* startChat(agent, opened, withoutRestarts(options));
        const pressCtrlC = () => terminal.mockInput.pressKey("c", { ctrl: true });

        yield* Effect.promise(() => terminal.mockInput.typeText("Hi."));
        terminal.mockInput.pressEnter();
        yield* frameWith(terminal, "esc cancel");
        yield* Effect.promise(() => terminal.mockInput.typeText("/re"));
        yield* frameWith(terminal, "▸ /restart");

        pressCtrlC();

        const closed = yield* frameWith(
          terminal,
          "enter steer · tab queue · esc cancel · ctrl+d quit",
        );

        expect(closed).not.toContain("▸ /restart");
        expect(closed).toContain("/re");

        pressCtrlC();
        const cleared = yield* frameWhere(terminal, (frame) => !frame.includes("/re"));
        expect(cleared).toContain("Running");

        pressCtrlC();
        yield* frameWith(terminal, "enter send · shift+enter new line · ctrl+d quit");

        pressCtrlC();
        expect(yield* Fiber.join(chat)).toEqual({ reason: "quit", session: opened.session.id });
      }).pipe(Effect.scoped),
    ));

  test("Tab puts the chosen command in the input, and Escape closes the list it opens", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const agent = yield* harness.startAgent([]);
        const opened = yield* agent.open(Option.none(), harness.directory);
        const { terminal } = yield* startChat(agent, opened, withoutRestarts(options));

        yield* Effect.promise(() => terminal.mockInput.typeText("/mo"));
        yield* frameWith(terminal, "▸ /model");
        terminal.mockInput.pressTab();
        yield* frameWith(terminal, "│/model ");
        terminal.mockInput.pressEnter();
        yield* frameWith(terminal, "Type to filter");

        terminal.mockInput.pressEscape();
        const frame = yield* frameWhere(terminal, (shown) => !shown.includes("Type to filter"));
        expect(frame).toContain("Type a prompt");
      }).pipe(Effect.scoped),
    ));

  test("conditions show above the input, errors first, and go when cleared", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const agent = yield* harness.startAgent([]);
        const opened = yield* agent.open(Option.none(), harness.directory);
        const { terminal, status } = yield* startChat(agent, opened, withoutRestarts(options));

        const warning = {
          key: "build",
          severity: "warning",
          text: "The new code does not build.",
        } as const;

        yield* status.set(warning, "detail");
        yield* status.set({ key: "crash", severity: "error", text: "Tau crashed." }, "detail");
        const frame = yield* frameWith(terminal, "! The new code does not build.");

        expect(frame).toMatch(/✗ Tau crashed\.\s*\n.*! The new code does not build\.\s*\n.*┌/);
        yield* status.clear("build");
        yield* status.clear("crash");
        const cleared = yield* frameWhere(terminal, (now) => !now.includes("Tau crashed."));

        expect(cleared).not.toContain("does not build");
      }).pipe(Effect.scoped),
    ));
});
