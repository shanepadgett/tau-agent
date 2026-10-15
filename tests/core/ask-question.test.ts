import { describe, expect, test } from "bun:test";
import { Effect, Option, Stream } from "effect";
import type { Response } from "effect/ai";
import {
  isRunEnd,
  options,
  prompt,
  type Reply,
  runEnd,
  takeUntil,
  textReply,
  withHarness,
} from "../support/agent-harness.ts";

const SELECT = {
  id: "store",
  prompt: "Which store?",
  kind: "select",
  options: [{ label: "SQLite" }, { label: "JSON" }],
};

const CONFIRM = { id: "old", prompt: "Delete old sessions?", kind: "confirm" };

const askReply = (questions: unknown): Reply =>
  Stream.make<Response.StreamPartEncoded[]>({
    type: "tool-call",
    id: "call-1",
    name: "ask_question",
    params: { questions },
  });

/** Sends `/qna` with the question tool on, then the answers, and gives what each run did. */
const qnaRuns = (replies: readonly Reply[]) =>
  withHarness((harness) =>
    Effect.gen(function* () {
      const agent = yield* harness.startAgent(replies);
      const opened = yield* agent.open(Option.none(), harness.directory);
      const events = yield* opened.subscribe;

      yield* opened.send({
        type: "prompt",
        text: "/qna",
        options: { ...options, askQuestions: true },
      });

      const first = runEnd(yield* takeUntil(events, isRunEnd));
      const callsAfterFirst = harness.prompts.length;
      const second = runEnd(yield* prompt(opened, "Answers: ..."));
      return { first, callsAfterFirst, second };
    }),
  );

describe("ask_question", () => {
  test("a valid call ends the run with the questions", async () => {
    const { first, callsAfterFirst } = await qnaRuns([
      askReply([SELECT, CONFIRM]),
      textReply("Thanks."),
    ]);

    expect(first).toMatchObject({ type: "run-ended", reason: "questions-asked" });

    expect(first?.type === "run-ended" && "questions" in first ? first.questions : []).toHaveLength(
      2,
    );

    expect(callsAfterFirst).toBe(1);
  });

  test("the run that carries the answers does not stop on the old questions", async () => {
    const { second } = await qnaRuns([askReply([SELECT, CONFIRM]), textReply("Thanks.")]);

    expect(second).toEqual({ type: "run-ended", reason: "answered" });
  });

  test("two questions with one id go back to the model to fix", async () => {
    const { first, callsAfterFirst } = await qnaRuns([
      askReply([CONFIRM, CONFIRM]),
      textReply("Sorry."),
      textReply("Unused."),
    ]);

    expect(first).toEqual({ type: "run-ended", reason: "answered" });
    expect(callsAfterFirst).toBe(2);
  });

  test("a recommendation that is not an option, or has no reason, goes back to the model", async () => {
    const unknown = { ...CONFIRM, recommendation: { answer: "Maybe", reason: "Unsure." } };
    const noReason = { ...CONFIRM, recommendation: { answer: "Yes", reason: "" } };

    const fine = {
      ...SELECT,
      recommendation: { answer: "SQLite", reason: "Already a dependency." },
    };

    for (const [bad, expectedCalls] of [
      [unknown, 2],
      [noReason, 2],
      [fine, 1],
    ] as const) {
      const { callsAfterFirst } = await qnaRuns([
        askReply([bad]),
        textReply("Fixed."),
        textReply("Unused."),
      ]);

      expect(callsAfterFirst).toBe(expectedCalls);
    }
  });

  test("only a run started with /qna offers the tool", async () => {
    const offered = await withHarness((harness) =>
      Effect.gen(function* () {
        const agent = yield* harness.startAgent([textReply("One."), textReply("Two.")]);
        const opened = yield* agent.open(Option.none(), harness.directory);
        yield* prompt(opened, "Hello");
        const events = yield* opened.subscribe;

        yield* opened.send({
          type: "prompt",
          text: "/qna",
          options: { ...options, askQuestions: true },
        });

        yield* takeUntil(events, isRunEnd);

        return harness.tools.map((descriptions) =>
          descriptions.includes("Puts questions to the user"),
        );
      }),
    );

    expect(offered).toEqual([false, true]);
  });
});
