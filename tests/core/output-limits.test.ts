import { describe, expect, test } from "bun:test";
import { Effect, FileSystem, Option } from "effect";
import { MAX_OUTPUT_BYTES } from "../../src/proc/Output.ts";
import {
  prompt,
  runEnd,
  runReply,
  textReply,
  toolResults,
  withHarness,
  withPreparedHarness,
} from "../support/agent-harness.ts";

const oversized = `START${"x".repeat(MAX_OUTPUT_BYTES)}END`;
const printLarge = `console.log(${JSON.stringify(oversized)})`;

describe("tool output limits", () => {
  test("saves bounded text and a complete file, then replays identical text in a new agent and branch", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const agent = yield* harness.startAgent([
          runReply("large", printLarge),
          textReply("Done."),
        ]);

        const opened = yield* agent.open(Option.none(), harness.directory);
        expect(runEnd(yield* prompt(opened, "Print."))).toMatchObject({ reason: "answered" });
        const text = toolResults(harness.prompts[1])[0];
        if (text === undefined) throw new Error("Missing tool result");
        expect(text).toStartWith("START");
        expect(text).toEndWith("END");
        expect(text).toContain("[Output shortened.");
        expect(text?.length).toBeLessThan(MAX_OUTPUT_BYTES + 1000);
        const entries = yield* harness.sessions.entries(opened.session.id, 0);
        const saved = entries.find(({ body }) => body.type === "tool-result");

        if (saved?.body.type !== "tool-result" || saved.body.details?.tool !== "run")
          throw new Error("Missing saved run");

        const path = saved.body.details.output;
        if (path === undefined) throw new Error("Missing output file");
        expect(saved.body.result).toBe(text);

        expect(text).toContain(
          `[Output shortened. Full output saved at ${path}. Search that file or print less.]`,
        );

        expect(path).toContain(`/output/${opened.session.id}/`);
        expect(yield* (yield* FileSystem.FileSystem).readFileString(path)).toBe(oversized);
        const branch = yield* harness.sessions.fork(opened.session.id, saved.number);
        const reopened = yield* harness.startAgent([textReply("Again."), textReply("Branch.")]);

        yield* prompt(
          yield* reopened.open(Option.some(opened.session.id), harness.directory),
          "Again.",
        );

        yield* prompt(yield* reopened.open(Option.some(branch.id), harness.directory), "Branch.");
        expect(toolResults(harness.prompts[2])[0]).toBe(text);
        expect(toolResults(harness.prompts[3])[0]).toBe(text);
      }),
    ));

  test("parallel shell calls spill to different files even when the script prints none of them", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const code =
          'await Promise.all([tools.sh({command: "seq 1 3000"}), tools.sh({command: "seq 1 3000"})]); console.log("done")';

        const agent = yield* harness.startAgent([runReply("parallel", code), textReply("Done.")]);
        const opened = yield* agent.open(Option.none(), harness.directory);
        yield* prompt(opened, "Run.");
        const fileSystem = yield* FileSystem.FileSystem;
        const directory = `${harness.home}/output/${opened.session.id}`;
        const files = yield* fileSystem.readDirectory(directory);
        expect(files).toHaveLength(2);
        expect(new Set(files).size).toBe(2);

        for (const file of files) {
          const text = yield* fileSystem.readFileString(`${directory}/${file}`);
          expect(text).toStartWith("1\n2\n");
          expect(text).toEndWith("3000\n");
        }

        expect(toolResults(harness.prompts[1])[0]).toBe("done");
      }),
    ));

  test("a shell preview links to output that another shell call can search", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const code = [
          'const first = await tools.sh({command: "seq 1 3000"});',
          "console.log(first.output);",
          'const path = first.output.split("Full output saved at ")[1].split(". Search that file")[0];',
          'const found = await tools.sh({command: `grep -n "^1500$" "${path}"`});',
          "console.log(found.output);",
        ].join("\n");

        const agent = yield* harness.startAgent([runReply("search", code), textReply("Done.")]);
        const opened = yield* agent.open(Option.none(), harness.directory);
        yield* prompt(opened, "Search.");
        const text = toolResults(harness.prompts[1])[0];
        expect(text).toContain("Full output saved at ");
        expect(text).toEndWith("1500:1500\n");
      }),
    ));

  test("a shell timeout keeps its preview and full log in the failed result", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const agent = yield* harness.startAgent([
          runReply(
            "timeout",
            'await tools.sh({command: "seq 1 3000; sleep 5", timeoutSeconds: 0.2})',
          ),
          textReply("Stopped."),
        ]);

        const opened = yield* agent.open(Option.none(), harness.directory);
        yield* prompt(opened, "Run.");
        const text = toolResults(harness.prompts[1])[0];
        expect(text).toContain("Tau stopped it");
        expect(text).toContain("Full output saved at ");
        const entries = yield* harness.sessions.entries(opened.session.id, 0);

        expect(entries.find(({ body }) => body.type === "tool-result")?.body).toMatchObject({
          isFailure: true,
        });

        const fileSystem = yield* FileSystem.FileSystem;
        const directory = `${harness.home}/output/${opened.session.id}`;
        const files = yield* fileSystem.readDirectory(directory);
        const shellFile = files.find((file) => file.startsWith("sh-"));
        if (shellFile === undefined) throw new Error("Missing shell output");
        const whole = yield* fileSystem.readFileString(`${directory}/${shellFile}`);
        expect(whole).toStartWith("1\n2\n");
        expect(whole).toEndWith("3000\n");
      }),
    ));

  test("an interpreter cut links only the retained script output", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const code =
          'for (let index = 0; index < 12; index++) console.log("x".repeat(1024 * 1024));';

        const agent = yield* harness.startAgent([
          runReply("interpreter", code),
          textReply("Done."),
        ]);

        const opened = yield* agent.open(Option.none(), harness.directory);
        yield* prompt(opened, "Print.");
        const text = toolResults(harness.prompts[1])[0];
        expect(text).toContain("Retained output saved at ");
        expect(text).toContain("[output cut]");
        expect(text?.length).toBeLessThan(MAX_OUTPUT_BYTES + 1000);
        const entries = yield* harness.sessions.entries(opened.session.id, 0);
        const saved = entries.find(({ body }) => body.type === "tool-result")?.body;

        if (
          saved?.type !== "tool-result" ||
          saved.details?.tool !== "run" ||
          saved.details.output === undefined
        )
          throw new Error("Missing output file");

        const whole = yield* (yield* FileSystem.FileSystem).readFileString(saved.details.output);
        expect(whole.length).toBeLessThan(12 * 1024 * 1024);
        expect(whole).toContain("[output cut]");
      }),
    ));

  test("a linked output folder fails the call and leaves the target empty", () =>
    withPreparedHarness(
      (home) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          yield* fileSystem.makeDirectory(`${home}/target`);
          yield* fileSystem.symlink(`${home}/target`, `${home}/output`);
        }),
      (harness) =>
        Effect.gen(function* () {
          const agent = yield* harness.startAgent([
            runReply("blocked", printLarge),
            textReply("Done."),
          ]);

          const opened = yield* agent.open(Option.none(), harness.directory);
          yield* prompt(opened, "Print.");
          expect(toolResults(harness.prompts[1])[0]).toContain("Cannot save output");

          expect(
            yield* (yield* FileSystem.FileSystem).readDirectory(`${harness.home}/target`),
          ).toEqual([]);

          const entries = yield* harness.sessions.entries(opened.session.id, 0);

          expect(entries.find(({ body }) => body.type === "tool-result")?.body).toMatchObject({
            isFailure: true,
          });
        }),
    ));
});
