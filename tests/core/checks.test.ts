import { describe, expect, test } from "bun:test";
import { Effect, FileSystem, Option, Schema } from "effect";
import type { AgentEvent } from "../../src/core/Client.ts";
import {
  checksReply,
  prompt,
  runEnd,
  runReply,
  textReply,
  toolResults,
  userTexts,
  withHarness,
} from "../support/agent-harness.ts";
import { initRepository } from "../support/git.ts";

/** A fixer that prints noise and makes each `.txt` file it gets upper case. */
const UPPER_CASE_FIX = {
  name: "upper-case",
  command:
    'echo fixer-noise; seq 1 3000; for file in {files}; do tr a-z A-Z < "$file" > "$file.tmp" && mv "$file.tmp" "$file"; done',
  include: ["*.txt"],
};

/** A check that fails while a `.txt` file it gets has the word "bad", and prints that file. */
const NO_BAD_CHECK = {
  name: "no-bad",
  details: "Finds the word bad.",
  command: "! grep -l bad {files}",
  include: ["*.txt"],
};

const BAD_TOOL_DESCRIPTION = "Runs the project's checks";

const writeNotes = (text: string) => `await tools.sh({ command: "echo ${text} > notes.txt" })`;

const writeChecks = (directory: string, checks: object) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    yield* fileSystem.makeDirectory(`${directory}/.tau`, { recursive: true });

    yield* fileSystem.writeFileString(
      `${directory}/.tau/checks.json`,
      Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))(checks),
    );
  });

/** The check output for notes.txt, whose path git gives with symbolic links resolved. */
const notesFailure = (directory: string) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fileSystem) => fileSystem.realPath(directory)),
    Effect.map((realDirectory) => `Failed: no-bad\n${realDirectory}/notes.txt`),
  );

const checkStarts = (events: readonly AgentEvent[]) =>
  events.filter((event) => event.type === "checks-started");

describe("project checks", () => {
  test("a fixer changes the files a script changed, and its output reaches no one", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        yield* initRepository(harness.directory, {});
        yield* writeChecks(harness.directory, { fix: [UPPER_CASE_FIX] });

        const agent = yield* harness.startAgent([
          runReply("call-1", writeNotes("hello")),
          textReply("Done."),
        ]);

        const opened = yield* agent.open(Option.none(), harness.directory);
        const events = yield* prompt(opened, "Write notes.");

        expect(runEnd(events)).toEqual({ type: "run-ended", reason: "answered" });
        expect(harness.prompts).toHaveLength(2);
        expect(toolResults(harness.prompts[1]).join("")).not.toContain("fixer-noise");
        expect(harness.tools[0]).not.toContain(BAD_TOOL_DESCRIPTION);

        const fileSystem = yield* FileSystem.FileSystem;
        expect(yield* fileSystem.readFileString(`${harness.directory}/notes.txt`)).toBe("HELLO\n");

        const entries = yield* harness.sessions.entries(opened.session.id, 0);
        const result = entries.find(({ body }) => body.type === "tool-result")?.body;

        expect(result).toMatchObject({
          details: { changes: { type: "files", paths: ["notes.txt"] } },
        });
      }),
    ));

  test("the checks tool reports a failure and then a pass, and Tau runs no checks itself", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        yield* initRepository(harness.directory, {});
        yield* writeChecks(harness.directory, { check: [NO_BAD_CHECK] });

        const agent = yield* harness.startAgent([
          runReply("call-1", writeNotes("bad")),
          checksReply("call-2"),
          runReply("call-3", writeNotes("good")),
          checksReply("call-4"),
          textReply("Done."),
        ]);

        const opened = yield* agent.open(Option.none(), harness.directory);
        const events = yield* prompt(opened, "Write notes.");

        expect(runEnd(events)).toEqual({ type: "run-ended", reason: "answered" });
        expect(checkStarts(events)).toEqual([]);
        expect(harness.tools[0]).toContain(`${BAD_TOOL_DESCRIPTION}`);
        expect(harness.tools[0]).toContain("- no-bad: Finds the word bad.");

        // Anthropic rejects a tool whose input is not an object.
        expect(harness.toolInputs[0]).toEqual([
          expect.objectContaining({ type: "object" }),
          expect.objectContaining({ type: "object" }),
        ]);

        const [, failed, , passed] = toolResults(harness.prompts[4]);
        expect(failed).toBe(yield* notesFailure(harness.directory));
        expect(passed).toBe("Passed: no-bad");
      }),
    ));

  test("when the model ends its turn with failing changes, Tau sends the failure back", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        yield* initRepository(harness.directory, {});
        yield* writeChecks(harness.directory, { check: [NO_BAD_CHECK] });

        const agent = yield* harness.startAgent([
          runReply("call-1", writeNotes("bad")),
          textReply("Done."),
          runReply("call-2", writeNotes("good")),
          textReply("Fixed."),
        ]);

        const opened = yield* agent.open(Option.none(), harness.directory);
        const events = yield* prompt(opened, "Write notes.");

        expect(runEnd(events)).toEqual({ type: "run-ended", reason: "answered" });
        expect(harness.prompts).toHaveLength(4);
        expect(checkStarts(events)).toHaveLength(2);
        expect(events).toContainEqual({ type: "checks-ended", failed: ["no-bad"] });
        expect(events).toContainEqual({ type: "checks-ended", failed: [] });

        expect(userTexts(harness.prompts[2]).at(-1)).toEndWith(
          yield* notesFailure(harness.directory),
        );
      }),
    ));

  test("checks that still fail after three send-backs end the run", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        yield* initRepository(harness.directory, {});
        yield* writeChecks(harness.directory, { check: [NO_BAD_CHECK] });

        const agent = yield* harness.startAgent([
          runReply("call-1", writeNotes("bad")),
          textReply("Done."),
          textReply("Done."),
          textReply("Done."),
          textReply("Done."),
        ]);

        const opened = yield* agent.open(Option.none(), harness.directory);
        const events = yield* prompt(opened, "Write notes.");

        expect(runEnd(events)).toEqual({
          type: "run-ended",
          reason: "checks-failed",
          checks: ["no-bad"],
        });

        expect(harness.prompts).toHaveLength(5);
        expect(checkStarts(events)).toHaveLength(4);
      }),
    ));

  test("outside git, any script makes every check run once, and a prompt without scripts runs none", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const ran = `${harness.home}/ran.log`;
        const counter = { name: "counter", command: `echo ran >> '${ran}'` };
        yield* writeChecks(harness.directory, { check: [counter] });

        const agent = yield* harness.startAgent([
          runReply("call-1", 'console.log("hi")'),
          textReply("Done."),
          textReply("Hello."),
        ]);

        const opened = yield* agent.open(Option.none(), harness.directory);
        const first = yield* prompt(opened, "Say hi.");
        const second = yield* prompt(opened, "Say hello.");

        expect(runEnd(first)).toEqual({ type: "run-ended", reason: "answered" });
        expect(runEnd(second)).toEqual({ type: "run-ended", reason: "answered" });
        expect(checkStarts(first)).toEqual([{ type: "checks-started", checks: ["counter"] }]);
        expect(checkStarts(second)).toEqual([]);

        const fileSystem = yield* FileSystem.FileSystem;
        expect(yield* fileSystem.readFileString(ran)).toBe("ran\n");
      }),
    ));

  test("a checks file that is not JSON fails the run and names the file", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        yield* fileSystem.makeDirectory(`${harness.directory}/.tau`);
        yield* fileSystem.writeFileString(`${harness.directory}/.tau/checks.json`, "{ fix: [");

        const agent = yield* harness.startAgent([textReply("Hello.")]);
        const opened = yield* agent.open(Option.none(), harness.directory);
        const end = runEnd(yield* prompt(opened, "Say hello."));

        expect(end).toMatchObject({ reason: "failed" });

        expect(end?.type === "run-ended" && "error" in end ? end.error : "").toContain(
          `${harness.directory}/.tau/checks.json is not valid JSON`,
        );
      }),
    ));
});
