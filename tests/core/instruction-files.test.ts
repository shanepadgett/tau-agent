import { describe, expect, test } from "bun:test";
import { Effect, FileSystem, Option } from "effect";
import {
  prompt,
  runReply,
  systemText,
  textReply,
  userTexts,
  withHarness,
} from "../support/agent-harness.ts";

const writeFiles = Effect.fn("writeFiles")(function* (files: Readonly<Record<string, string>>) {
  const fileSystem = yield* FileSystem.FileSystem;

  for (const [path, content] of Object.entries(files)) {
    yield* fileSystem.makeDirectory(path.slice(0, path.lastIndexOf("/")), { recursive: true });
    yield* fileSystem.writeFileString(path, content);
  }
});

describe("instruction files", () => {
  test("an always file goes in the system prompt, a read-when file is listed, and a file with wrong front matter is skipped", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const folder = `${harness.directory}/.tau/instructions`;

        yield* writeFiles({
          [`${harness.home}/.tau/instructions/shared.md`]: "---\nalways: true\n---\nShared rule.",
          [`${folder}/style.md`]: "---\nalways: true\n---\n\nUse tabs.\n",
          [`${folder}/deploy.md`]:
            "---\nread-when: When you deploy\n  the app.\n---\nRun make deploy.",
          [`${folder}/no-header.md`]: "No header rule.",
          [`${folder}/bad-yaml.md`]: "---\nread-when: [unclosed\n---\nBad YAML rule.",
          [`${folder}/no-when.md`]: "---\nalways: false\n---\nNo when rule.",
          [`${folder}/wrong-type.md`]: "---\nalways: yes please\n---\nWrong type rule.",
          [`${folder}/notes.txt`]: "---\nalways: true\n---\nText file rule.",
        });

        const agent = yield* harness.startAgent([textReply("Done.")]);
        yield* prompt(yield* agent.open(Option.none(), harness.directory), "Hi.");
        const [system] = systemText(harness.prompts[0]);

        expect(system).toContain(
          `<instructions path="${folder}/style.md">\nUse tabs.\n</instructions>`,
        );

        expect(system).toContain("Shared rule.");
        expect(system).toContain(`- deploy (${folder}/deploy.md): When you deploy the app.`);
        expect(system).not.toContain("Run make deploy.");

        for (const skipped of ["No header", "Bad YAML", "No when", "Wrong type", "Text file"]) {
          expect(system).not.toContain(`${skipped} rule.`);
        }
      }),
    ));

  test("a new read-when file comes as a note, and a file that stops being always no longer applies", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const folder = `${harness.directory}/.tau/instructions`;
        yield* writeFiles({ [`${folder}/style.md`]: "---\nalways: true\n---\nUse tabs." });

        const agent = yield* harness.startAgent([
          runReply(
            "call-1",
            [
              'await tools.write({ path: ".tau/instructions/style.md", content: "---\\nread-when: When you style code.\\n---\\nUse tabs." })',
              'await tools.write({ path: ".tau/instructions/test.md", content: "---\\nread-when: When you test.\\n---\\nRun bun test." })',
            ].join("\n"),
          ),
          textReply("Done."),
        ]);

        yield* prompt(yield* agent.open(Option.none(), harness.directory), "Change them.");
        const notes = userTexts(harness.prompts[1]).slice(1).join("\n");

        expect(notes).toContain(`The instructions from ${folder}/style.md no longer apply.`);

        expect(notes).toContain(
          [
            "Read an instruction file when its situation applies:",
            `- style (${folder}/style.md): When you style code.`,
            `- test (${folder}/test.md): When you test.`,
          ].join("\n"),
        );
      }),
    ));

  test("the instruction file in the folder closest to the session directory wins", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const app = `${harness.directory}/app`;

        yield* writeFiles({
          [`${harness.directory}/.tau/instructions/style.md`]:
            "---\nalways: true\n---\nRoot style.",
          [`${app}/.tau/instructions/style.md`]: "---\nalways: true\n---\nApp style.",
          [`${harness.directory}/.tau/instructions/lint.md`]: "---\nalways: true\n---\nRoot lint.",
        });

        expect(Bun.spawnSync(["git", "init", "-q"], { cwd: harness.directory }).exitCode).toBe(0);

        const agent = yield* harness.startAgent([textReply("Done.")]);
        yield* prompt(yield* agent.open(Option.none(), app), "Hi.");
        const [system] = systemText(harness.prompts[0]);

        expect(system).toContain("App style.");
        expect(system).toContain("Root lint.");
        expect(system).not.toContain("Root style.");
      }),
    ));

  test('"agentsFiles": false turns off every AGENTS.md, and a session that read them is told', () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        yield* writeFiles({
          [`${harness.home}/.agents/AGENTS.md`]: "User rules.",
          [`${harness.directory}/AGENTS.md`]: "Project rules.",
        });

        const first = yield* harness.startAgent([textReply("First.")]);
        const opened = yield* first.open(Option.none(), harness.directory);
        yield* prompt(opened, "Hi.");
        expect(systemText(harness.prompts[0])[0]).toContain("Project rules.");

        yield* writeFiles({ [`${harness.home}/.tau/settings.json`]: '{ "agentsFiles": false }' });
        const second = yield* harness.startAgent([textReply("unused"), textReply("Second.")]);

        yield* prompt(
          yield* second.open(Option.some(opened.session.id), harness.directory),
          "Again.",
        );

        const notes = userTexts(harness.prompts[1]).join("\n");

        expect(notes).toContain(
          `The instructions from ${harness.home}/.agents/AGENTS.md no longer apply.`,
        );

        expect(notes).toContain(
          `The instructions from ${harness.directory}/AGENTS.md no longer apply.`,
        );

        const fresh = yield* harness.startAgent([
          textReply("unused"),
          textReply("unused"),
          textReply("Third."),
        ]);

        yield* prompt(yield* fresh.open(Option.none(), harness.directory), "New.");
        expect(systemText(harness.prompts[2])[0]).not.toContain("rules.");
      }),
    ));
});
