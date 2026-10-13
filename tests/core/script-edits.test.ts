import { describe, expect, test } from "bun:test";
import { Effect, Option, Stream } from "effect";
import type { Prompt, Response } from "effect/ai";
import {
  prompt,
  type Reply,
  runEnd,
  runReply,
  textReply,
  toolResults,
  withHarness,
} from "../support/agent-harness.ts";

type Edit = { readonly old: string; readonly new: string };

const BROKEN = 'console.log("start")\nthrow new Error("broken")';
const FIX: Edit = { old: 'throw new Error("broken")', new: 'console.log("fixed")' };

const editReply = (id: string, scriptId: number, edits: readonly Edit[]): Reply =>
  Stream.make<Response.StreamPartEncoded[]>({
    type: "tool-call",
    id,
    name: "run",
    params: { scriptId, edits },
  });

/** The script ID at the end of the last tool result the model got, as a model reads it. */
const lastScriptId = (sent: Prompt.Prompt | undefined) => {
  const match = /Script ID: (\d+)$/u.exec(toolResults(sent).at(-1) ?? "");
  return Number(match?.[1]);
};

/** A reply that edits the script of the last failed result in model call `call`. */
const fixLastScript = (prompts: readonly Prompt.Prompt[], call: number, edits: readonly Edit[]) =>
  Stream.suspend(() => editReply("call-2", lastScriptId(prompts[call]), edits));

describe("script edits", () => {
  test("a failed script's result ends with its ID, and an edit call runs the fixed script", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const agent = yield* harness.startAgent([
          runReply("call-1", BROKEN),
          fixLastScript(harness.prompts, 1, [FIX]),
          textReply("Done."),
        ]);

        const opened = yield* agent.open(Option.none(), harness.directory);
        yield* prompt(opened, "Print something.");

        const [failed, fixed] = toolResults(harness.prompts[2]);
        const scriptId = lastScriptId(harness.prompts[1]);
        expect(failed).toBe(`start\nExecutionFailure: Error: broken\n\nScript ID: ${scriptId}`);
        expect(fixed).toBe("start\nfixed");

        const entries = yield* harness.sessions.entries(opened.session.id, 0);

        expect(entries.find((entry) => entry.number === scriptId)?.body).toMatchObject({
          callId: "call-1",
          script: BROKEN,
        });

        const edited = entries.find(
          ({ body }) => body.type === "tool-result" && body.callId === "call-2",
        );

        expect(edited?.body).toMatchObject({
          script: 'console.log("start")\nconsole.log("fixed")',
        });
      }),
    ));

  test("an edit whose old text appears twice fails, names the edit, and runs nothing", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const agent = yield* harness.startAgent([
          runReply("call-1", `${BROKEN}\nconsole.log("start")`),
          fixLastScript(harness.prompts, 1, [FIX, { old: 'console.log("start")', new: "" }]),
          textReply("Done."),
        ]);

        yield* prompt(yield* agent.open(Option.none(), harness.directory), "Print something.");

        const scriptId = lastScriptId(harness.prompts[1]);

        expect(toolResults(harness.prompts[2])[1]).toBe(
          `Edit 2 of script ${scriptId}: the text to replace appears 2 times, not once. Nothing ran; fix the edits and send them again.`,
        );
      }),
    ));

  test("an edit of a script that does not exist fails", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const agent = yield* harness.startAgent([
          editReply("call-1", 999, [FIX]),
          textReply("Done."),
        ]);

        yield* prompt(yield* agent.open(Option.none(), harness.directory), "Print something.");

        expect(toolResults(harness.prompts[1])).toEqual([
          "There is no script 999. Send the whole program as code.",
        ]);
      }),
    ));

  test("a call that sends both code and a script ID fails", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const agent = yield* harness.startAgent([
          Stream.make<Response.StreamPartEncoded[]>({
            type: "tool-call",
            id: "call-1",
            name: "run",
            params: { code: "1", scriptId: 1, edits: [FIX] },
          }),
          textReply("Done."),
        ]);

        yield* prompt(yield* agent.open(Option.none(), harness.directory), "Print something.");

        expect(toolResults(harness.prompts[1])).toEqual([
          "Send code, or scriptId and edits, not both.",
        ]);
      }),
    ));

  test("a call with wrong parameters fails as a tool result, and the run goes on", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const agent = yield* harness.startAgent([
          Stream.make<Response.StreamPartEncoded[]>({
            type: "tool-call",
            id: "call-1",
            name: "run",
            params: { code: null, scriptId: 1, edits: [], timeoutSeconds: null },
          }),
          textReply("Done."),
        ]);

        const opened = yield* agent.open(Option.none(), harness.directory);
        const events = yield* prompt(opened, "Print something.");

        expect(runEnd(events)).toEqual({ type: "run-ended", reason: "answered" });
        expect(toolResults(harness.prompts[1])[0]).toStartWith("The run parameters are wrong:");
      }),
    ));

  test("a script ID still works after a new agent opens the session", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const first = yield* harness.startAgent([runReply("call-1", BROKEN), textReply("Failed.")]);
        const opened = yield* first.open(Option.none(), harness.directory);
        yield* prompt(opened, "Print something.");

        const second = yield* harness.startAgent([
          textReply("unused"),
          textReply("unused"),
          fixLastScript(harness.prompts, 1, [FIX]),
          textReply("Done."),
        ]);

        const reopened = yield* second.open(Option.some(opened.session.id), harness.directory);
        yield* prompt(reopened, "Try again.");

        expect(toolResults(harness.prompts[3]).at(-1)).toBe("start\nfixed");
      }),
    ));
});
