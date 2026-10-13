import { describe, expect, test } from "bun:test";
import { Effect, FileSystem, Option } from "effect";
import { prompt, runReply, textReply, withHarness } from "../support/agent-harness.ts";

const NOTES = "one\ntwo\nthree\nfour\n";

/** A script that changes four lines of one file at the same time, through the given paths. */
const replaceAll = (paths: readonly string[]) =>
  [
    "await Promise.all([",
    ...["one", "two", "three", "four"].map(
      (word, index) =>
        `  tools.replace({ path: ${JSON.stringify(paths[index % paths.length])}, old: "${word}", new: "${word.toUpperCase()}" }),`,
    ),
    "])",
  ].join("\n");

describe("write queue", () => {
  test("replace calls on one file at the same time keep every edit", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        yield* fileSystem.writeFileString(`${harness.directory}/notes.txt`, NOTES);

        const agent = yield* harness.startAgent([
          runReply("call-1", replaceAll(["notes.txt"])),
          textReply("Done."),
        ]);

        yield* prompt(yield* agent.open(Option.none(), harness.directory), "Edit the notes.");

        expect(yield* fileSystem.readFileString(`${harness.directory}/notes.txt`)).toBe(
          "ONE\nTWO\nTHREE\nFOUR\n",
        );
      }),
    ));

  test("a file reached through a symlinked folder shares the queue of its real path", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        yield* fileSystem.makeDirectory(`${harness.directory}/real`);
        yield* fileSystem.symlink(`${harness.directory}/real`, `${harness.directory}/link`);
        yield* fileSystem.writeFileString(`${harness.directory}/real/notes.txt`, NOTES);

        const agent = yield* harness.startAgent([
          runReply("call-1", replaceAll(["real/notes.txt", "link/notes.txt"])),
          textReply("Done."),
        ]);

        yield* prompt(yield* agent.open(Option.none(), harness.directory), "Edit the notes.");

        expect(yield* fileSystem.readFileString(`${harness.directory}/real/notes.txt`)).toBe(
          "ONE\nTWO\nTHREE\nFOUR\n",
        );
      }),
    ));
});
