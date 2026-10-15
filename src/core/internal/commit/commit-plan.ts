/**
 * Asks a model to group the changed files into conventional commits, and checks its answer: every
 * file in exactly one commit, and each message a conventional commit.
 */

import { Effect, Schema } from "effect";
import { type LanguageModel, Prompt } from "effect/ai";
import type { PlannedCommit } from "../../Commits.ts";
import type { ChangedFile } from "../../../workspace/Git.ts";

/** Evidence past this many characters is cut, so a huge diff still fits a small model. */
const MAX_EVIDENCE_CHARACTERS = 48_000;
const MAX_PROMPT_CHARACTERS = 2000;
const CONVENTIONAL = /^[a-z]+(?:\([^()\n]+\))?!?: \S/u;

const PlanAnswer = Schema.Struct({
  commits: Schema.Array(
    Schema.Struct({
      /** The whole commit message: the subject line, then a blank line and a body if needed. */
      message: Schema.String,
      /** The numbers of the files in this commit, from the file list. */
      files: Schema.Array(Schema.Int),
    }),
  ),
});

type PlanAnswer = typeof PlanAnswer.Type;

class PlanRejected extends Schema.TaggedError<PlanRejected>()("PlanRejected", {
  message: Schema.String,
}) {}

export type PlanEvidence = {
  readonly files: readonly ChangedFile[];
  readonly diff: string;
  readonly subjects: readonly string[];
  /** The user's prompts in this session since the last commit. */
  readonly prompts: readonly string[];
  readonly instruction: string;
  readonly avoidBreakingChanges: boolean;
};

const RULES = `You group a repository's changed files into git commits.

- Make the fewest commits that each hold one honest, self-contained change. One commit is often right.
- Keep docs, tests, lockfiles and generated files with the code they belong to. Do not split by file type or folder alone.
- Put every file number in exactly one commit.
- Write each message as a conventional commit: \`type(scope): subject\`, lowercase type such as feat, fix, refactor, docs, test, chore. Keep the subject under 72 characters, in the imperative mood, with no period.
- Add a body after a blank line only when the subject cannot say why.
- Follow the style of the recent subjects.
- The user's instruction, when there is one, comes first.`;

/** The plan, after one retry when the model's answer breaks a rule. */
export const planCommits = Effect.fn("planCommits")(function* (
  model: LanguageModel.LanguageModel,
  evidence: PlanEvidence,
) {
  const ask = (feedback: string) =>
    model
      .generateObject({
        prompt: Prompt.fromMessages([
          Prompt.systemMessage({ content: RULES }),
          Prompt.userMessage({
            content: [Prompt.textPart({ text: evidenceText(evidence) + feedback })],
          }),
        ]),
        schema: PlanAnswer,
        objectName: "commit_plan",
      })
      .pipe(Effect.map(({ value }) => value));

  const first = yield* ask("");
  const problem = planProblem(first, evidence);
  if (problem === undefined) return planned(first, evidence.files);

  const second = yield* ask(`\n\nYour last plan was wrong: ${problem} Answer again.`);
  const secondProblem = planProblem(second, evidence);
  if (secondProblem === undefined) return planned(second, evidence.files);
  return yield* new PlanRejected({ message: `The model's plan was wrong twice: ${secondProblem}` });
});

const evidenceText = (evidence: PlanEvidence) => {
  const sections = [
    evidence.instruction === "" ? "" : `User's instruction: ${evidence.instruction}`,
    evidence.avoidBreakingChanges
      ? "Do not mark any commit as a breaking change: no `!` and no BREAKING CHANGE footer."
      : "Mark a commit that breaks users with `!` after its type and a BREAKING CHANGE footer.",
    "Changed files:",
    evidence.files.map((file, index) => `${index + 1}. ${fileLine(file)}`).join("\n"),
    evidence.subjects.length === 0
      ? ""
      : `Recent commit subjects:\n${evidence.subjects.join("\n")}`,
    evidence.prompts.length === 0
      ? ""
      : `What the user asked for in this session:\n${evidence.prompts
          .map((prompt) => `- ${prompt.slice(0, MAX_PROMPT_CHARACTERS)}`)
          .join("\n")}`,
    `Diff:\n${cut(evidence.diff)}`,
  ];

  return sections.filter((section) => section !== "").join("\n\n");
};

const fileLine = (file: ChangedFile) =>
  file.previousPath === undefined
    ? `${file.path} (${file.status})`
    : `${file.path} (renamed from ${file.previousPath})`;

const cut = (diff: string) =>
  diff.length <= MAX_EVIDENCE_CHARACTERS
    ? diff
    : `${diff.slice(0, MAX_EVIDENCE_CHARACTERS)}\n[diff cut at ${MAX_EVIDENCE_CHARACTERS} characters]`;

/** Why the answer breaks a rule, or undefined when it keeps them all. */
const planProblem = (answer: PlanAnswer, evidence: PlanEvidence) => {
  const count = evidence.files.length;
  const numbers = answer.commits.flatMap(({ files }) => files);

  const missing = Array.from({ length: count }, (_, index) => index + 1).filter(
    (number) => !numbers.includes(number),
  );

  if (answer.commits.length === 0) return "It has no commits.";

  if (numbers.some((number) => number < 1 || number > count))
    return `It uses file numbers outside 1 to ${count}.`;

  if (new Set(numbers).size !== numbers.length) return "It puts a file in more than one commit.";
  if (missing.length > 0) return `It leaves out files ${missing.join(", ")}.`;
  if (answer.commits.some(({ files }) => files.length === 0)) return "A commit has no files.";

  const subjects = answer.commits.map(({ message }) => message.split("\n")[0] ?? "");
  const bad = subjects.find((subject) => !CONVENTIONAL.test(subject));
  if (bad !== undefined) return `"${bad}" is not a conventional commit subject.`;

  const breaks = answer.commits.some(
    ({ message }) =>
      /^[a-z]+(?:\([^()\n]+\))?!:/u.test(message) || message.includes("BREAKING CHANGE"),
  );

  return evidence.avoidBreakingChanges && breaks ? "It has a breaking change." : undefined;
};

const planned = (answer: PlanAnswer, files: readonly ChangedFile[]): readonly PlannedCommit[] =>
  answer.commits.map(({ message, files: numbers }) => ({
    message: message.trim(),
    files: numbers.flatMap((number) => files.slice(number - 1, number)),
  }));
