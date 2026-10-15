import { describe, expect, test } from "bun:test";
import { Effect, Option } from "effect";
import { prompt, textReply, userTexts, withHarness } from "../support/agent-harness.ts";
import { initRepository, shell } from "../support/git.ts";

describe("folder listings", () => {
  test("a tagged folder reaches the model listed one level deep, folders first, without ignored names", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        yield* initRepository(harness.directory, {
          ".gitignore": "src/build/\n",
          "src/b.ts": "",
          "src/a.ts": "",
          "src/lib/c.ts": "",
        });

        yield* shell(harness.directory, "mkdir -p src/build && touch src/build/out.js");
        const agent = yield* harness.startAgent([textReply("Done."), textReply("Again.")]);
        const opened = yield* agent.open(Option.none(), harness.directory);

        yield* prompt(opened, "Look at @src/ and @src/a.ts.");

        const sent = userTexts(harness.prompts[0]).join("\n");
        expect(sent).toContain("Look at @src/ and @src/a.ts.");

        expect(sent).toContain(
          '<reminder kind="folder-listings">\nFolder @src/, as the message was sent:\nlib/\na.ts\nb.ts\n</reminder>',
        );

        // Saved once: a later call sends the same listing, even after the folder changed.
        yield* shell(harness.directory, "touch src/d.ts");
        yield* prompt(opened, "Thanks.");
        const later = userTexts(harness.prompts[1]).join("\n");
        expect(later).toContain("lib/\na.ts\nb.ts\n</reminder>\nThanks.");
      }),
    ));

  test("a reference tagged by its full path is listed", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const reference = `${harness.home}/.tau/references/opencode`;

        yield* shell(
          harness.directory,
          `mkdir -p ${reference}/packages && touch ${reference}/README.md`,
        );

        const agent = yield* harness.startAgent([textReply("Done.")]);
        const opened = yield* agent.open(Option.none(), harness.directory);

        yield* prompt(opened, `What is in @${reference}/ now?`);

        expect(userTexts(harness.prompts[0]).join("\n")).toContain(
          `Folder @${reference}/, as the message was sent:\npackages/\nREADME.md\n</reminder>`,
        );
      }),
    ));

  test("a message that tags no folder gets no listing", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const agent = yield* harness.startAgent([textReply("Done.")]);
        const opened = yield* agent.open(Option.none(), harness.directory);

        yield* prompt(opened, "Mail me@example.com about @missing/.");

        expect(userTexts(harness.prompts[0]).join("\n")).not.toContain("folder-listings");
      }),
    ));
});
