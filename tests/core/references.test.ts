import { describe, expect, test } from "bun:test";
import { Effect, FileSystem, Option } from "effect";
import { prompt, systemText, textReply, userTexts, withHarness } from "../support/agent-harness.ts";

const makeReference = Effect.fn("makeReference")(function* (home: string, name: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  yield* fileSystem.makeDirectory(`${home}/.tau/references/${name}`, { recursive: true });
});

describe("references", () => {
  test("references attached before the first prompt are in the system prompt", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        yield* makeReference(harness.home, "opencode");
        yield* makeReference(harness.home, "opentui");
        const agent = yield* harness.startAgent([textReply("Done.")]);
        const opened = yield* agent.open(Option.none(), harness.directory);

        yield* opened.references.set(["opencode", "opentui"]);
        yield* prompt(opened, "Hello.");

        const [system] = systemText(harness.prompts[0]);

        expect(system).toContain(
          `Reference repositories are read-only git clones in ${harness.home}/.tau/references/<name>.`,
        );

        expect(system).toContain("Attached: opencode, opentui");
      }),
    ));

  test("a reference attached later arrives as one note, and a deleted folder drops out", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        yield* makeReference(harness.home, "opencode");
        const agent = yield* harness.startAgent([textReply("First."), textReply("Second.")]);
        const opened = yield* agent.open(Option.none(), harness.directory);

        yield* prompt(opened, "Hello.");
        yield* opened.references.set(["opencode"]);
        yield* prompt(opened, "Again.");

        const [system] = systemText(harness.prompts[0]);
        expect(system).not.toContain("Attached");
        const update = userTexts(harness.prompts[1]).join("\n");
        expect(update).toContain('<reminder kind="instructions">');
        expect(update).toContain("Attached: opencode");
        expect(update).toContain("read-only git clones");

        yield* (yield* FileSystem.FileSystem).remove(`${harness.home}/.tau/references/opencode`, {
          recursive: true,
        });

        yield* prompt(opened, "Once more.");

        expect(userTexts(harness.prompts[2]).join("\n")).toContain(
          "No reference repositories are attached any more.",
        );
      }),
    ));
});
