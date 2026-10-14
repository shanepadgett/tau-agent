import { describe, expect, test } from "bun:test";
import { Duration, Effect, Option } from "effect";
import {
  options,
  prompt,
  runEnd,
  runReply,
  isRunEnd,
  takeUntil,
  textReply,
  toolResults,
  userTexts,
  withHarness,
} from "../support/agent-harness.ts";
import { checkpointReply, contextLayer, promptText } from "../support/compaction.ts";

const startScript = (command: string) =>
  `return await tools.process.start({ command: ${JSON.stringify(command)}, waitSeconds: 0.25 });`;

describe("process sessions in a run", () => {
  test("a command that exits during the run is reported once, before the next model call", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const agent = yield* harness.startAgent([
          runReply("start", startScript("sleep 0.3; echo bye; exit 3")),
          runReply("busy", `await tools.sh({ command: "sleep 0.3" });`),
          textReply("Noted."),
          textReply("Still noted."),
        ]);

        const opened = yield* agent.open(Option.none(), harness.directory);
        expect(runEnd(yield* prompt(opened, "Start it."))?.reason).toBe("answered");

        const notice = userTexts(harness.prompts[2]).filter((text) => text.includes("exited"));
        expect(notice).toHaveLength(1);
        expect(notice[0]).toContain("Process session p1");
        expect(notice[0]).toContain("exited with code 3");
        expect(notice[0]).toContain("bye");

        yield* prompt(opened, "Anything else?");
        const later = userTexts(harness.prompts[3]).filter((text) => text.includes("exited"));
        expect(later).toHaveLength(1);
      }),
    ));

  test("a script that times out leaves its process session running", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const agent = yield* harness.startAgent([
          runReply(
            "hang",
            `${startScript("sleep 30").replace("return ", "")}\nawait tools.sh({ command: "sleep 5" });`,
          ),
          textReply("It timed out."),
          runReply("list", "return await tools.process.list({});"),
          textReply("Done."),
        ]);

        const opened = yield* agent.open(Option.none(), harness.directory);
        const events = yield* opened.subscribe;

        yield* opened.send({
          type: "prompt",
          text: "Hang.",
          options: {
            ...options,
            timeouts: { run: Duration.millis(400), shell: Duration.seconds(5) },
          },
        });

        yield* takeUntil(events, isRunEnd);
        yield* prompt(opened, "List them.");

        expect(toolResults(harness.prompts[3]).at(-1)).toContain("running");
        expect(toolResults(harness.prompts[1]).at(-1)).toContain("timed out");
      }),
    ));

  test("a checkpoint saves the running commands and the next view lists them after the handoff", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const agent = yield* harness.startAgentUsing(
          [
            runReply("start", startScript("sleep 30")),
            checkpointReply("cp"),
            textReply("Checkpointed."),
          ],
          contextLayer({ notesStartTokens: 1_000_000 }),
        );

        const opened = yield* agent.open(Option.none(), harness.directory);
        expect(runEnd(yield* prompt(opened, "Start a server."))?.reason).toBe("answered");

        const view = promptText(harness.prompts[2]);
        expect(view).toContain("Process sessions running at the checkpoint");
        expect(view).toContain("p1: sleep 30");
        expect(promptText(harness.prompts[1])).not.toContain("Process sessions running");
      }),
    ));
});
