import { describe, expect, test } from "bun:test";
import { Effect, Stream } from "effect";
import { LanguageModel, type Response } from "effect/ai";
import { planCommits, type PlanEvidence } from "../../src/core/internal/commit/commit-plan.ts";

const EVIDENCE: PlanEvidence = {
  files: [
    { path: "src/a.ts", previousPath: undefined, status: "modified" },
    { path: "tests/a.test.ts", previousPath: undefined, status: "added" },
    { path: "README.md", previousPath: undefined, status: "modified" },
  ],
  diff: "diff --git a/src/a.ts b/src/a.ts",
  subjects: ["feat: start"],
  prompts: ["add a"],
  instruction: "",
  avoidBreakingChanges: true,
};

/** Plans with a model that gives `answers` in order, and counts its calls. */
const planWith = (answers: readonly unknown[]) =>
  Effect.runPromise(
    Effect.gen(function* () {
      let calls = 0;

      const model = yield* LanguageModel.make({
        generateText: () => {
          const answer = answers[Math.min(calls, answers.length - 1)];
          calls += 1;

          return Effect.succeed<Response.PartEncoded[]>([
            { type: "text", text: JSON.stringify(answer) },
          ]);
        },
        streamText: () => Stream.die("Plans use no stream."),
      });

      const plan = yield* planCommits(model, EVIDENCE).pipe(Effect.result);
      return { plan, calls };
    }),
  );

const GOOD = {
  commits: [
    { message: "feat(a): add a", files: [1, 2] },
    { message: "docs: describe a", files: [3] },
  ],
};

describe("commit plans", () => {
  test("a good answer becomes commits of the changed files", async () => {
    const { plan, calls } = await planWith([GOOD]);

    expect(calls).toBe(1);
    expect(plan._tag).toBe("Success");

    if (plan._tag === "Success")
      expect(
        plan.success.map(({ message, files }) => [message, files.map(({ path }) => path)]),
      ).toEqual([
        ["feat(a): add a", ["src/a.ts", "tests/a.test.ts"]],
        ["docs: describe a", ["README.md"]],
      ]);
  });

  test("an answer that leaves out a file is asked again once", async () => {
    const missing = { commits: [{ message: "feat: add a", files: [1, 2] }] };
    const { plan, calls } = await planWith([missing, GOOD]);

    expect(calls).toBe(2);
    expect(plan._tag).toBe("Success");
  });

  test("a breaking change twice, when breaking changes are not wanted, fails the plan", async () => {
    const breaking = { commits: [{ message: "feat!: add a", files: [1, 2, 3] }] };
    const { plan, calls } = await planWith([breaking]);

    expect(calls).toBe(2);
    expect(plan._tag).toBe("Failure");
  });
});
