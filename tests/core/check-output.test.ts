import { describe, expect, test } from "bun:test";
import { Effect, FileSystem, Option, Schema } from "effect";
import { MAX_OUTPUT_BYTES } from "../../src/proc/Output.ts";
import {
  checksReply,
  prompt,
  runReply,
  textReply,
  toolResults,
  userTexts,
  withHarness,
} from "../support/agent-harness.ts";

const checksFile = (directory: string, commands: readonly string[]) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    yield* fileSystem.makeDirectory(`${directory}/.tau`);

    const checks = commands.map((command, index) => ({
      name: `check-${index}`,
      command: `if test ! -e okay; then ${command}; exit 1; fi`,
    }));

    yield* fileSystem.writeFileString(
      `${directory}/.tau/checks.json`,
      Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))({ check: checks }),
    );
  });

describe("check output limits", () => {
  for (const mode of ["tool", "settle"]) {
    test(`${mode} caps a combined report even when each command is below the cap`, () =>
      withHarness((harness) =>
        Effect.gen(function* () {
          const command = `awk 'BEGIN {for (counter = 0; counter < 35000; counter++) printf "x"}'`;
          yield* checksFile(harness.directory, [command, command]);
          const trigger = mode === "tool" ? checksReply("checks") : textReply("Done.");

          const agent = yield* harness.startAgent([
            runReply("start", 'console.log("start")'),
            trigger,
            runReply("fix", 'await tools.write({path: "okay", content: "fixed"})'),
            textReply("Fixed."),
          ]);

          const opened = yield* agent.open(Option.none(), harness.directory);
          yield* prompt(opened, "Check.");
          const entries = yield* harness.sessions.entries(opened.session.id, 0);

          const reports = entries.flatMap(({ body }) => {
            if (body.type === "checks") return [body.report];

            return body.type === "tool-result" && body.details?.tool === "checks"
              ? [body.details.report]
              : [];
          });

          const failed = reports.find((report) => report.failed.length > 0);
          if (failed?.output === undefined) throw new Error("Missing combined report file");
          expect(failed.text.length).toBeLessThan(MAX_OUTPUT_BYTES + 1000);
          expect(failed.text).toContain("[Output shortened.");
          expect(failed.failed).toHaveLength(2);
          expect(failed.failed.every((check) => check.file === undefined)).toBe(true);
          const whole = yield* (yield* FileSystem.FileSystem).readFileString(failed.output);
          expect(whole).toContain("Failed: check-0");
          expect(whole).toContain("Failed: check-1");
          expect(whole.length).toBeGreaterThan(MAX_OUTPUT_BYTES);

          const modelText =
            mode === "tool"
              ? toolResults(harness.prompts[2]).at(-1)
              : userTexts(harness.prompts[2]).at(-1);

          expect(modelText).toContain(failed.text);
          expect(reports.at(-1)?.failed).toEqual([]);
        }),
      ));
  }

  test("a command's whole log survives the cap on the rendered report", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        yield* checksFile(harness.directory, ["seq 1 3000"]);

        const agent = yield* harness.startAgent([
          runReply("start", 'console.log("start")'),
          checksReply("checks"),
          runReply("fix", 'await tools.write({path: "okay", content: "fixed"})'),
          textReply("Fixed."),
        ]);

        const opened = yield* agent.open(Option.none(), harness.directory);
        yield* prompt(opened, "Check.");
        const entries = yield* harness.sessions.entries(opened.session.id, 0);

        const saved = entries.find(
          ({ body }) => body.type === "tool-result" && body.details?.tool === "checks",
        )?.body;

        if (saved?.type !== "tool-result" || saved.details?.tool !== "checks")
          throw new Error("Missing checks result");

        const report = saved.details.report;
        const commandPath = report.failed[0]?.file;

        if (commandPath === undefined || report.output === undefined)
          throw new Error("Missing output files");

        const fileSystem = yield* FileSystem.FileSystem;
        const whole = yield* fileSystem.readFileString(commandPath);
        expect(whole).toStartWith("1\n2\n");
        expect(whole).toEndWith("3000\n");
        expect(yield* fileSystem.readFileString(report.output)).toContain(commandPath);
        expect(saved.details.output).toBe(report.output);
      }),
    ));
});
