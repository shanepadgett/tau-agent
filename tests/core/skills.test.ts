import { describe, expect, test } from "bun:test";
import { Effect, FileSystem, Option, Stream } from "effect";
import {
  prompt,
  runReply,
  systemText,
  textReply,
  toolResults,
  userTexts,
  withHarness,
} from "../support/agent-harness.ts";

const SKILL_COUNT = 30;
const LONG_DESCRIPTION = "Use it for a task that needs many words to describe. ".repeat(4);

const writeSkill = Effect.fn("writeSkill")(function* (folder: string, skillFile: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  yield* fileSystem.makeDirectory(folder, { recursive: true });
  yield* fileSystem.writeFileString(`${folder}/SKILL.md`, skillFile);
});

const skillFile = (name: string, description: string) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\nThe ${name} steps.\n`;

describe("skills", () => {
  test("a script finds a skill with search and loads it, and the run description leaves skills out", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const skills = `${harness.directory}/.agents/skills`;
        yield* writeSkill(`${skills}/pdf-forms`, skillFile("pdf-forms", "Fills in PDF forms."));
        yield* writeSkill(`${skills}/no-description`, "---\nname: no-description\n---\nSteps.");

        yield* writeSkill(
          `${skills}/release`,
          "---\nname: release\ndescription: Releases.\ndisable-model-invocation: true\n---\nSteps.",
        );

        const agent = yield* harness.startAgent([
          runReply(
            "call-1",
            'const found = search({ namespace: "skills", query: "pdf" })\nconsole.log(found.items.map((item) => item.path).join(", "))\nreturn await tools.skills["pdf-forms"]()',
          ),
          textReply("Done."),
        ]);

        const opened = yield* agent.open(Option.none(), harness.directory);
        yield* prompt(opened, "Fill the form.");

        const [system] = systemText(harness.prompts[0]);
        expect(system).toContain("- pdf-forms: Fills in PDF forms.");
        expect(system).not.toContain("release");
        expect(system).not.toContain("no-description");

        const [result] = toolResults(harness.prompts[1]);
        expect(result).toStartWith('tools.skills["pdf-forms"]\n');
        expect(result).toContain(`Skill folder: ${skills}/pdf-forms\n\nThe pdf-forms steps.`);
        expect(result).not.toContain("description:");

        const entries = yield* harness.sessions.entries(opened.session.id, 0);
        const saved = entries.flatMap(({ body }) => (body.type === "tool-result" ? [body] : []));

        expect(saved[0]?.details).toEqual({
          tool: "run",
          script: expect.any(String),
          files: [`${skills}/pdf-forms/SKILL.md`],
        });

        expect(harness.tools[0]).toContain("search(");
        expect(harness.tools[0]).not.toContain("pdf-forms");
      }),
    ));

  test("a skipped skill shows a warning until a later run reads it", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const folder = `${harness.directory}/.agents/skills/pdf-forms`;
        yield* writeSkill(folder, "---\nname: pdf-forms\n---\nSteps.");
        const agent = yield* harness.startAgent([textReply("First."), textReply("Second.")]);
        const opened = yield* agent.open(Option.none(), harness.directory);

        const conditions = Stream.runHead(harness.status.current).pipe(
          Effect.map(Option.getOrThrow),
        );

        yield* prompt(opened, "Hi.");

        expect(yield* conditions).toEqual([
          {
            key: `files.the skill ${folder}/SKILL.md`,
            severity: "warning",
            text: `Skipped the skill ${folder}/SKILL.md: it has no description.`,
          },
        ]);

        yield* writeSkill(folder, skillFile("pdf-forms", "Fills in PDF forms."));
        yield* prompt(opened, "Again.");
        expect(yield* conditions).toEqual([]);
      }),
    ));

  test("adding a skill does not change the run description", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const first = yield* harness.startAgent([textReply("First.")]);
        yield* prompt(yield* first.open(Option.none(), harness.directory), "Hi.");

        yield* writeSkill(
          `${harness.home}/.tau/skills/pdf-forms`,
          skillFile("pdf-forms", "Fills in PDF forms."),
        );

        const second = yield* harness.startAgent([textReply("unused"), textReply("Second.")]);
        yield* prompt(yield* second.open(Option.none(), harness.directory), "Hi.");

        expect(systemText(harness.prompts[1])[0]).toContain("pdf-forms");
        expect(harness.tools[1]).toBe(harness.tools[0] ?? "");
      }),
    ));

  test("the skill list is ranked by use, capped, counts the skills left out, and keeps its order in a session", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        for (let index = 1; index <= SKILL_COUNT; index++) {
          const name = `skill-${String(index).padStart(2, "0")}`;

          yield* writeSkill(
            `${harness.home}/.tau/skills/${name}`,
            skillFile(name, LONG_DESCRIPTION),
          );
        }

        yield* writeSkill(
          `${harness.directory}/.tau/skills/zeta`,
          skillFile("zeta", "A project skill."),
        );

        const first = yield* harness.startAgent([
          runReply("call-1", 'await tools.skills["skill-30"]()'),
          textReply("First."),
        ]);

        yield* prompt(yield* first.open(Option.none(), harness.directory), "Use skill 30.");
        const [before] = systemText(harness.prompts[0]);
        expect(before).toContain("\n- zeta: A project skill.\n- skill-01:");
        expect(before).toMatch(/\n\d+ more skills are not listed\. Find them with search/);
        expect(before).not.toContain("- skill-30:");

        const second = yield* harness.startAgent([
          textReply("unused"),
          textReply("unused"),
          runReply("call-2", 'await tools.skills["skill-29"]()'),
          textReply("Second."),
          textReply("Third."),
        ]);

        const opened = yield* second.open(Option.none(), harness.directory);
        yield* prompt(opened, "Use skill 29.");
        yield* prompt(opened, "Again.");
        const [after = ""] = systemText(harness.prompts[2]);

        expect(after).toContain("\n- skill-30:");
        expect(after.indexOf("- skill-30:")).toBeLessThan(after.indexOf("- zeta:"));
        expect(systemText(harness.prompts[4])).toEqual([after]);
        expect(userTexts(harness.prompts[4]).join("\n")).not.toContain("skills are now");
      }),
    ));
});
