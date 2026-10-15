/**
 * Finds skills, the `<name>/SKILL.md` folders of the Agent Skills standard, ranks them by use, and
 * gives the skill list the model sees and one script function per skill.
 */

import { basename, join } from "node:path";
import { Namespace, Tool as ScriptFunction } from "@opencode/codemode";
import { Effect, FileSystem, Option, Schema } from "effect";
import type { Touched } from "../../../sandbox/Sandbox.ts";
import type { Entry } from "../../../session/Entry.ts";
import {
  readFrontMatter,
  reportSkipped,
  skipped,
  skipUnreadable,
} from "../instructions/front-matter.ts";
import { type InstructionSource, savedValues } from "../instructions/instructions.ts";

/** The group of the skill functions, so a script calls `tools.skills["<name>"]()`. */
export const SKILLS_GROUP = "skills";

const SKILL_FILE = "SKILL.md";
const SKILLS_KEY = "tau/skills";
const MAX_LIST_CHARACTERS = 4000;
const MAX_NAME_LENGTH = 64;
const NAME_RULE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const LISTED_LINE = /^- (.+?): /;

/** Fields of the standard that Tau uses, and Claude Code's field for skills only the user starts. */
const SkillHeader = Schema.Struct({
  name: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  "disable-model-invocation": Schema.optional(Schema.Boolean),
});

type Scope = "user" | "project";

export type Skill = {
  readonly name: string;
  readonly description: string;
  /** The path of the `SKILL.md` file. */
  readonly path: string;
  /** The skill's folder, where the files the skill names are. */
  readonly folder: string;
  /** The text after the front matter. */
  readonly body: string;
  readonly scope: Scope;
};

/** The skill folders, each list most shared first. */
export type SkillFolders = {
  readonly user: readonly string[];
  readonly project: readonly string[];
};

/** The skills of a run, and the use score of each skill that was used before. */
export type FoundSkills = {
  readonly skills: readonly Skill[];
  readonly ranking: ReadonlyMap<string, number>;
};

/**
 * The skills the model can use. A skill in a later folder replaces one of the same name, so the
 * folder closest to the session directory wins. A skill only the user starts is left out.
 */
export const findSkills = Effect.fn("findSkills")(function* (folders: SkillFolders) {
  const user = yield* Effect.forEach(folders.user, (folder) => skillsIn(folder, "user"));
  const project = yield* Effect.forEach(folders.project, (folder) => skillsIn(folder, "project"));
  const byName = new Map([...user.flat(), ...project.flat()]);
  return [...byName.values()].flatMap(Option.toArray);
});

/** Each skill in `folder` by name. None for a skill only the user starts. */
type NamedSkill = readonly [string, Option.Option<Skill>];

const skillsIn = (folder: string, scope: Scope) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    if (!(yield* fileSystem.exists(folder))) return [];
    const names = (yield* fileSystem.readDirectory(folder)).toSorted();

    const found = yield* Effect.forEach(names, (name) =>
      fileSystem
        .exists(join(folder, name, SKILL_FILE))
        // An entry that is a file, such as .DS_Store, has no SKILL.md under it and is not a skill.
        .pipe(
          Effect.orElseSucceed(() => false),
          Effect.flatMap((exists) =>
            exists ? readSkill(join(folder, name), scope) : Effect.succeed(Option.none()),
          ),
        ),
    );

    return found.flatMap(Option.toArray);
  }).pipe(
    Effect.catch((error) =>
      reportSkipped(`the skills in ${folder}`, error.message).pipe(
        Effect.as<readonly NamedSkill[]>([]),
      ),
    ),
  );

/** Follows the standard's advice to clients: skip a skill that cannot work, load one that can. */
const readSkill = (folder: string, scope: Scope) =>
  Effect.gen(function* () {
    const path = join(folder, SKILL_FILE);
    const text = yield* (yield* FileSystem.FileSystem).readFileString(path);
    const { header, body } = yield* readFrontMatter(SkillHeader, text);
    const description = (header.description ?? "").replaceAll(/\s+/g, " ").trim();

    if (description === "") {
      return yield* skipped<NamedSkill>(`the skill ${path}`, "it has no description");
    }

    const folderName = basename(folder);
    const name = header.name ?? folderName;

    const isNameValid =
      name === folderName && name.length <= MAX_NAME_LENGTH && NAME_RULE.test(name);

    if (!isNameValid) {
      yield* Effect.logWarning(
        `The skill ${path} has the name "${name}", which is not its folder name or breaks the naming rules. Tau uses it anyway.`,
      );
    }

    const skill: Skill = { name, description, path, folder, body, scope };
    const isUserOnly = header["disable-model-invocation"] === true;
    const named: NamedSkill = [name, isUserOnly ? Option.none() : Option.some(skill)];
    return Option.some(named);
  }).pipe(skipUnreadable<NamedSkill>(`the skill ${folder}`, `its ${SKILL_FILE}`));

/** Most used first. Without uses, project skills come before the user's, then by name. */
const ranked = ({ skills, ranking }: FoundSkills) =>
  skills.toSorted(
    (left, right) =>
      (ranking.get(right.name) ?? 0) - (ranking.get(left.name) ?? 0) ||
      Number(right.scope === "project") - Number(left.scope === "project") ||
      left.name.localeCompare(right.name),
  );

/** One script function per skill, in the skills group, which the `run` description leaves out. */
export const skillFunctions = (
  skills: readonly Skill[],
  touched: Touched,
  used: (skill: Skill) => Effect.Effect<void>,
) =>
  Namespace.make({
    description: "Skills: instructions for particular tasks",
    tools: Object.fromEntries(
      skills.map((skill) => [
        skill.name,
        ScriptFunction.make({
          description: skill.description,
          input: Schema.Struct({}),
          output: Schema.String,
          execute: () =>
            touched(skill.path).pipe(
              Effect.andThen(used(skill)),
              Effect.as(`Skill folder: ${skill.folder}\n\n${skill.body}`),
            ),
        }),
      ]),
    ),
  });

/**
 * The list of skills the model sees: ranked on its first reading, then kept in that order for the
 * session, so a later change note names only the skills that came or went.
 */
export const skillListSource = (
  found: FoundSkills,
  entries: readonly Entry[],
): InstructionSource<never, never> => ({
  key: SKILLS_KEY,
  read: Effect.succeed(skillList(found, savedValues(entries)[SKILLS_KEY] ?? null)),
  first: (value) =>
    [
      'Skills hold instructions for particular tasks. When a skill\'s task applies, load the skill in a run script with `await tools.skills["<name>"]()` and follow it.',
      value,
    ].join("\n"),
  changed: (value) => `The skills are now:\n${value}`,
  removed: "There are no skills any more.",
});

const skillList = (found: FoundSkills, saved: string | null) => {
  if (found.skills.length === 0) return Option.none<string>();
  const listedBefore = listedNames(saved);

  const order = [
    ...listedBefore.flatMap((name) => found.skills.filter((skill) => skill.name === name)),
    ...ranked(found).filter((skill) => !listedBefore.includes(skill.name)),
  ];

  const lines = linesThatFit(order.map((skill) => `- ${skill.name}: ${skill.description}`));
  const unlisted = found.skills.length - lines.length;

  const more =
    unlisted === 0
      ? []
      : [
          `${unlisted} more skills are not listed. Find them with search({ namespace: "${SKILLS_GROUP}", query }).`,
        ];

  return Option.some([...lines, ...more].join("\n"));
};

const listedNames = (saved: string | null) =>
  (saved ?? "").split("\n").flatMap((line) => {
    const name = LISTED_LINE.exec(line)?.[1];
    return name === undefined ? [] : [name];
  });

/** The first lines that fit in the list's character limit together. */
const linesThatFit = (lines: readonly string[]) => {
  let characters = 0;

  return lines.filter((line) => {
    characters += line.length + 1;
    return characters <= MAX_LIST_CHARACTERS;
  });
};
