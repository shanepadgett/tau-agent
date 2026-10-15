/** The questions the model asks the user with `ask_question`, as the tool receives and saves them. */

import { Schema } from "effect";

const AnswerOption = Schema.Struct({
  label: Schema.String.check(Schema.isMinLength(1)),
  description: Schema.optional(Schema.String),
});

/** The model's suggested answer and why. The reason is required. */
const Recommendation = Schema.Struct({
  answer: Schema.String.check(Schema.isMinLength(1)),
  reason: Schema.String.check(Schema.isMinLength(1)),
});

const Asked = {
  id: Schema.String.check(Schema.isMinLength(1)),
  prompt: Schema.String.check(Schema.isMinLength(1)),
  recommendation: Schema.optional(Recommendation),
};

/** The user picks one of `options`, or types an answer of their own. */
const SelectQuestion = Schema.Struct({
  ...Asked,
  kind: Schema.Literal("select"),
  options: Schema.Array(AnswerOption).check(Schema.isMinLength(2)),
});

/** The user answers Yes or No. */
const ConfirmQuestion = Schema.Struct({ ...Asked, kind: Schema.Literal("confirm") });

/** The user types an answer. */
const InputQuestion = Schema.Struct({ ...Asked, kind: Schema.Literal("input") });

export const Question = Schema.Union([SelectQuestion, ConfirmQuestion, InputQuestion]);
export type Question = typeof Question.Type;

/** What the `ask_question` tool takes. */
export const AskQuestionParameters = Schema.Struct({
  questions: Schema.Array(Question).check(Schema.isMinLength(1)),
});

/** The first id that two questions share, if any. */
export const repeatedQuestionId = (questions: readonly Question[]) => {
  const seen = new Set<string>();
  return questions.find(({ id }) => seen.size === seen.add(id).size)?.id;
};

const CONFIRM_ANSWERS = ["Yes", "No"];

/** What is wrong with the recommendation of the first question that has a bad one, if any. */
export const recommendationProblem = (questions: readonly Question[]) =>
  questions.map(badRecommendation).find((problem) => problem !== undefined);

const badRecommendation = (question: Question) => {
  const { recommendation } = question;
  if (recommendation === undefined || question.kind === "input") return;

  const labels =
    question.kind === "select" ? question.options.map(({ label }) => label) : CONFIRM_ANSWERS;

  if (labels.includes(recommendation.answer)) return;
  return `The recommendation of "${question.id}" is "${recommendation.answer}", which is not one of its options: ${labels.join(", ")}.`;
};
