import { describe, expect, test } from "bun:test";
import { Effect, Option } from "effect";
import type { AgentEvent } from "../../src/core/Client.ts";
import {
  isRunEnd,
  options,
  prompt,
  runReply,
  takeUntil,
  textReply,
  withHarness,
} from "../support/agent-harness.ts";

const startedPrompts = (events: readonly AgentEvent[]) =>
  events.flatMap((event) => (event.type === "run-started" ? [event.prompt] : []));

describe("events for a chat client", () => {
  test("each run starts with its prompt, in the order the prompts were sent", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const agent = yield* harness.startAgent([textReply("One."), textReply("Two.")]);
        const opened = yield* agent.open(Option.none(), harness.directory);
        const events = yield* opened.subscribe;

        yield* opened.send({ type: "prompt", text: "First.", options });
        yield* opened.send({ type: "prompt", text: "Second.", options });
        const first = yield* takeUntil(events, isRunEnd);
        const second = yield* takeUntil(events, isRunEnd);

        expect(first[0]).toEqual({ type: "run-started", prompt: "First." });
        expect(startedPrompts([...first, ...second])).toEqual(["First.", "Second."]);
      }),
    ));

  test("the history of a session replays its prompts, answers and tool calls", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const agent = yield* harness.startAgent([
          runReply("call-1", `console.log("hi");`),
          textReply("Done."),
        ]);

        const opened = yield* agent.open(Option.none(), harness.directory);
        const live = yield* prompt(opened, "Say hi.");
        const history = yield* opened.history;

        expect(history).toEqual(live.filter((event) => !isRunEnd(event)));

        expect(history.map((event) => event.type)).toEqual([
          "run-started",
          "tool-started",
          "tool-ended",
          "text",
        ]);
      }),
    ));
});
