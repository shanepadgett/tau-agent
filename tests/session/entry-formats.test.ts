import { describe, expect, test } from "bun:test";
import { Effect, FileSystem, Option, Schema, Stream } from "effect";
import type { Response } from "effect/ai";
import { openDatabase } from "../../src/database/Database.ts";
import { SessionId } from "../../src/session/Entry.ts";
import {
  prompt,
  type Reply,
  textReply,
  toolResults,
  withPreparedHarness,
} from "../support/agent-harness.ts";
import v3 from "./fixtures/sessions-v3.json";
import v4 from "./fixtures/sessions-v4.json";

/** The entry of the fixture's failed run result, which is its script ID. */
const SCRIPT_ID = 4;
const START_MILLIS = 1_760_000_000_000;

const toJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

/** Writes the fixture's sessions file, in its own format, before Tau opens it. */
type SessionFixture = {
  readonly migrations: readonly string[];
  readonly session: string;
  readonly entries: readonly { readonly type: string }[];
};

const writeFixture = (home: string, directory: string, fixture: SessionFixture) =>
  Effect.gen(function* () {
    yield* (yield* FileSystem.FileSystem).makeDirectory(`${home}/.tau`, { recursive: true });
    const database = yield* openDatabase(`${home}/.tau/sessions.db`, fixture.migrations);

    yield* database.writeTransaction((transaction) =>
      Effect.gen(function* () {
        yield* transaction.run("INSERT INTO session VALUES (?, ?, ?, ?, ?)", [
          fixture.session,
          directory,
          toJson({ kind: "new" }),
          START_MILLIS,
          START_MILLIS,
        ]);

        for (const [index, body] of fixture.entries.entries()) {
          const saved = toJson(body).replaceAll("{directory}", directory);

          yield* transaction.run("INSERT INTO entry VALUES (?, ?, ?, ?)", [
            fixture.session,
            index + 1,
            START_MILLIS,
            saved,
          ]);
        }
      }),
    );
  });

const editReply = (scriptId: number): Reply =>
  Stream.make<Response.StreamPartEncoded[]>({
    type: "tool-call",
    id: "call-2",
    name: "run",
    params: {
      scriptId,
      edits: [{ old: 'throw new Error("broken")', new: 'console.log("fixed")' }],
    },
  });

describe("entry formats", () => {
  test("a session saved at version 3 loads, its script can be edited, and its files still count", () =>
    withPreparedHarness(
      (home, directory) => writeFixture(home, directory, v3),
      (harness) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          yield* fileSystem.makeDirectory(`${harness.directory}/docs`);
          yield* fileSystem.writeFileString(`${harness.directory}/docs/guide.md`, "The guide.");
          yield* fileSystem.writeFileString(`${harness.directory}/docs/AGENTS.md`, "Docs rules.");

          const session = SessionId.make(v3.session);
          const saved = yield* harness.sessions.entries(session, 0);

          expect(saved.find((entry) => entry.number === SCRIPT_ID)?.body).toEqual({
            type: "tool-result",
            callId: "call-1",
            name: "run",
            result: "ExecutionFailure: Error: broken",
            isFailure: true,
            details: {
              tool: "run",
              files: [`${harness.directory}/docs/guide.md`],
              script: 'await tools.read({ path: "docs/guide.md" })\nthrow new Error("broken")',
            },
          });

          expect(saved.at(-1)?.body).not.toHaveProperty("details");
          expect(saved.at(-1)?.body).not.toHaveProperty("files");

          const agent = yield* harness.startAgent([editReply(SCRIPT_ID), textReply("Done.")]);
          const opened = yield* agent.open(Option.some(session), harness.directory);
          yield* prompt(opened, "Try again.");

          expect(toJson(harness.prompts[0])).toContain("Docs rules.");
          expect(toolResults(harness.prompts[1]).at(-1)).toBe("fixed");
        }),
    ));

  test("version 4 reports preserve whitespace and order in both saved report paths", () =>
    withPreparedHarness(
      (home, directory) => writeFixture(home, directory, v4),
      (harness) =>
        Effect.gen(function* () {
          const session = SessionId.make(v4.session);
          const entries = yield* harness.sessions.entries(session, 0);
          const text = "Passed: z\n\nPassed: a\n\nFailed: unicode\nerror\n\nFailed: empty\n";

          const reports = entries.flatMap(({ body }) => {
            if (body.type === "checks") return [body.report];

            return body.type === "tool-result" && body.details?.tool === "checks"
              ? [body.details.report]
              : [];
          });

          expect(reports.map((report) => report.text)).toEqual([text, text, ""]);
          const agent = yield* harness.startAgent([textReply("Done.")]);
          const opened = yield* agent.open(Option.some(session), harness.directory);
          yield* prompt(opened, "Again.");
          expect(toolResults(harness.prompts[0])[0]).toBe(text);
          expect(toJson(harness.prompts[0])).toContain(toJson(text).slice(1, -1));
        }),
    ));
});
