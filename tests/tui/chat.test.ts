import { describe, expect, test } from "bun:test";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { Context, Deferred, Effect, Fiber, Layer, Option, Stream } from "effect";
import type { OpenSession } from "../../src/core/Agent.ts";
import { Status } from "../../src/core/Status.ts";
import { type ChatOptions, type ChatSetup, type RestartLink, runTui } from "../../src/tui/Tui.ts";
import { options, prompt, runReply, textReply, withHarness } from "../support/agent-harness.ts";

const SCREEN = { width: 80, height: 24, kittyKeyboard: true };

const testTerminal = Effect.acquireRelease(
  Effect.promise(() => createTestRenderer(SCREEN)),
  (setup) => Effect.sync(() => setup.renderer.destroy()),
);

/** A supervisor that never restarts the chat. */
const noRestarts: RestartLink = {
  draft: "",
  reportActivity: () => Effect.void,
  requestRestart: Effect.void,
  exitRequested: Effect.never,
};

const withoutRestarts = (chatOptions: ChatOptions): ChatSetup => ({
  options: chatOptions,
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
  };

  return { link, exitRequested, reports };
});

/**
 * Starts the chat on a test terminal, with a status the test can set conditions in. The chat stops
 * when the test's scope closes.
 */
const startChat = Effect.fn("startChat")(function* (opened: OpenSession, setup: ChatSetup) {
  const terminal = yield* testTerminal;
  const services = yield* Layer.build(Status.layer);
  const tui = runTui(terminal.renderer, opened, setup).pipe(Effect.provideContext(services));
  const chat = yield* Effect.forkScoped(tui);

  yield* frameWith(terminal, "ctrl+d quit");
  return { terminal, chat, status: Context.get(services, Status) };
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
  test("a sent prompt shows with its tool calls and answer", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const agent = yield* harness.startAgent([
          runReply("call-1", `console.log("hi");`),
          textReply("All done."),
        ]);

        const opened = yield* agent.open(Option.none(), harness.directory);
        const { terminal } = yield* startChat(opened, withoutRestarts(options));

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

        const { terminal } = yield* startChat(opened, withoutRestarts(options));
        const frame = yield* frameWith(terminal, "Earlier answer.");

        expect(frame).toContain("Earlier prompt.");
      }).pipe(Effect.scoped),
    ));

  test("Shift-Enter adds a line, and Ctrl-D quits", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const agent = yield* harness.startAgent([]);
        const opened = yield* agent.open(Option.none(), harness.directory);
        const { terminal, chat } = yield* startChat(opened, withoutRestarts(options));

        yield* Effect.promise(() => terminal.mockInput.typeText("one"));
        terminal.mockInput.pressEnter({ shift: true });
        yield* Effect.promise(() => terminal.mockInput.typeText("two"));
        const frame = yield* frameWith(terminal, "two");

        expect(frame).toMatch(/one\s*│?\s*\n.*two/);
        terminal.mockInput.pressKey("d", { ctrl: true });
        expect(yield* Fiber.join(chat)).toEqual({ reason: "quit" });
      }).pipe(Effect.scoped),
    ));

  test("without a model, the chat opens and a sent prompt goes back with how to set one", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const agent = yield* harness.startAgent([]);
        const opened = yield* agent.open(Option.none(), harness.directory);

        const { terminal } = yield* startChat(
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
        const setup = { options, prompt: undefined, link: supervisor.link };
        const { terminal, chat } = yield* startChat(opened, setup);

        yield* Effect.promise(() => terminal.mockInput.typeText(" and more"));
        yield* frameWith(terminal, "carried over and more");
        yield* Deferred.succeed(supervisor.exitRequested, undefined);

        expect(yield* Fiber.join(chat)).toEqual({
          reason: "restart",
          draft: "carried over and more",
        });
      }).pipe(Effect.scoped),
    ));

  test("the chat reports when it is idle and takes /restart, with only the model and keys under the input", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const agent = yield* harness.startAgent([textReply("Hello.")]);
        const opened = yield* agent.open(Option.none(), harness.directory);
        const supervisor = yield* fakeSupervisor("");
        const setup = { options, prompt: undefined, link: supervisor.link };
        const { terminal } = yield* startChat(opened, setup);

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
        const setup = { options, prompt: undefined, link: supervisor.link };
        const { terminal } = yield* startChat(opened, setup);

        yield* Effect.promise(() => terminal.mockInput.typeText("Hi."));
        terminal.mockInput.pressEnter();
        yield* frameWith(terminal, "esc cancel");
        yield* Effect.promise(() => terminal.mockInput.typeText("/restart"));
        terminal.mockInput.pressEnter();
        yield* frameWith(terminal, "Tau restarts when this run ends.");

        expect(supervisor.reports).toContain("restart-request");
      }).pipe(Effect.scoped),
    ));

  test("conditions show above the input, errors first, and go when cleared", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const agent = yield* harness.startAgent([]);
        const opened = yield* agent.open(Option.none(), harness.directory);
        const { terminal, status } = yield* startChat(opened, withoutRestarts(options));

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
