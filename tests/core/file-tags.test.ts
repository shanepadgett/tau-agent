import { describe, expect, test } from "bun:test";
import { Effect, FileSystem, Schedule } from "effect";
import type { Agent } from "../../src/core/Agent.ts";
import type { TagSearch } from "../../src/core/FileTags.ts";
import { withHarness } from "../support/agent-harness.ts";

/** The rows once the index is ready; FFF scans in the background. */
const rowsFor = (
  agent: Agent["Service"],
  directory: string,
  attached: readonly string[],
  query: string,
) =>
  agent.files.find(directory, attached, query).pipe(
    Effect.repeat({
      until: (search: TagSearch) => search.state !== "indexing",
      schedule: Schedule.spaced("50 millis"),
    }),
    Effect.map((search) => (search.state === "ready" ? search.rows : [])),
    Effect.timeout("10 seconds"),
  );

describe("file tags", () => {
  test("the session's files come first, then the attached references the query starts", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        yield* fileSystem.writeFileString(`${harness.directory}/open.md`, "");

        yield* fileSystem.makeDirectory(`${harness.home}/.tau/references/opencode`, {
          recursive: true,
        });

        const agent = yield* harness.startAgent([]);

        const rows = yield* rowsFor(agent, harness.directory, ["opencode", "pi"], "op");

        expect(rows).toEqual([
          { kind: "file", path: "open.md", tag: "open.md" },
          { kind: "reference", name: "opencode", tag: `${harness.home}/.tau/references/opencode/` },
        ]);
      }),
    ));

  test("a query that starts with an attached reference searches it, and tags its full path", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const reference = `${harness.home}/.tau/references/opencode`;
        yield* fileSystem.makeDirectory(`${reference}/src`, { recursive: true });
        yield* fileSystem.writeFileString(`${reference}/src/search.ts`, "");
        const agent = yield* harness.startAgent([]);

        const rows = yield* rowsFor(agent, harness.directory, ["opencode"], "opencode/search");

        expect(rows[0]).toEqual({
          kind: "file",
          path: "opencode/src/search.ts",
          tag: `${reference}/src/search.ts`,
        });
      }),
    ));

  test("a reference that is not attached is a folder name like any other", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;

        yield* fileSystem.makeDirectory(`${harness.home}/.tau/references/opencode`, {
          recursive: true,
        });

        const agent = yield* harness.startAgent([]);

        expect(yield* rowsFor(agent, harness.directory, [], "opencode/")).toEqual([]);
      }),
    ));
});
