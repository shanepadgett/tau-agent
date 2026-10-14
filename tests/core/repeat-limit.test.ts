import { describe, expect, test } from "bun:test";
import { Effect, Option } from "effect";
import {
  prompt,
  type Reply,
  runEnd,
  runReply,
  textReply,
  withHarness,
} from "../support/agent-harness.ts";

const FAILING = 'throw new Error("broken")';

/** Runs `replies` on one prompt and gives the run's end and how many model calls it made. */
const runScript = (replies: readonly Reply[]) =>
  withHarness((harness) =>
    Effect.gen(function* () {
      const agent = yield* harness.startAgent(replies);
      const opened = yield* agent.open(Option.none(), harness.directory);
      const events = yield* prompt(opened, "Fix it.");
      return { end: runEnd(events), modelCalls: harness.prompts.length };
    }),
  );

describe("repeat limit", () => {
  test("the same failing call three times in a row ends the run and names the call", async () => {
    const { end, modelCalls } = await runScript([
      runReply("call-1", FAILING),
      runReply("call-2", FAILING),
      runReply("call-3", FAILING),
      textReply("Done."),
    ]);

    expect(end).toMatchObject({ type: "run-ended", reason: "repeated-call" });
    expect(end?.type === "run-ended" && "call" in end ? end.call : "").toContain("broken");
    expect(modelCalls).toBe(3);
  });

  test("a call with other parameters in between does not count as a repeat", async () => {
    const { end, modelCalls } = await runScript([
      runReply("call-1", FAILING),
      runReply("call-2", FAILING),
      runReply("call-3", 'throw new Error("other")'),
      runReply("call-4", FAILING),
      textReply("Done."),
    ]);

    expect(end).toEqual({ type: "run-ended", reason: "answered" });
    expect(modelCalls).toBe(5);
  });

  test("a call that passes in between does not count as a repeat", async () => {
    const { end, modelCalls } = await runScript([
      runReply("call-1", FAILING),
      runReply("call-2", FAILING),
      runReply("call-3", 'console.log("hi")'),
      runReply("call-4", FAILING),
      textReply("Done."),
    ]);

    expect(end).toEqual({ type: "run-ended", reason: "answered" });
    expect(modelCalls).toBe(5);
  });
});
