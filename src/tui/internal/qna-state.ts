/**
 * The `/qna` panel as data: the tabs, the cursor, what the user answered and noted, and the message
 * those answers make. Pure, so the panel only draws it and the tests step through it.
 */

import type { RunEnd } from "../../core/Client.ts";

/** One question the model asked: select, confirm or input. */
export type Question = Extract<RunEnd, { reason: "questions-asked" }>["questions"][number];

/** A select or confirm answer: the picked row, or the user's own text, plus a note per option. */
type ChoiceAnswer = {
  readonly kind: "choice";
  /** An option's index, `"other"` for the typed answer, or none yet. */
  readonly picked: number | "other" | undefined;
  readonly other: string;
  /** The user's notes by option index. A note stays when another option is picked. */
  readonly notes: Readonly<Record<number, string>>;
};

type Answer = ChoiceAnswer | { readonly kind: "text"; readonly text: string };

export type QnaState = {
  readonly questions: readonly Question[];
  readonly answers: readonly Answer[];
  readonly context: string;
  /** The tab in view: a question's index, or `questions.length` for Additional Context. */
  readonly tab: number;
  /** The row under the cursor on a select or confirm tab. */
  readonly row: number;
  /** The option whose note is being typed. */
  readonly noting: number | undefined;
  /** Whether the user tried to send while a question was open. */
  readonly isIncomplete: boolean;
};

/** What a tab holds, for the panel to draw and the keys to act on. */
export type Tab =
  | { readonly type: "choice"; readonly question: Question; readonly answer: ChoiceAnswer }
  | { readonly type: "input"; readonly question: Question; readonly text: string }
  | { readonly type: "context" };

export type Sent =
  | { readonly type: "incomplete"; readonly state: QnaState }
  | { readonly type: "answers"; readonly text: string };

export const qnaState = (questions: readonly Question[]): QnaState => ({
  questions,
  answers: questions.map((question): Answer =>
    question.kind === "input"
      ? { kind: "text", text: "" }
      : { kind: "choice", picked: undefined, other: "", notes: {} },
  ),
  context: "",
  tab: 0,
  row: 0,
  noting: undefined,
  isIncomplete: false,
});

const CONFIRM_LABELS = ["Yes", "No"];

/** The options of a select or confirm question, as the user reads them. */
export const optionLabels = (question: Question): readonly string[] => {
  if (question.kind === "select") return question.options.map(({ label }) => label);
  return question.kind === "confirm" ? CONFIRM_LABELS : [];
};

/** What the user sees below a select option's label, if the model gave it. */
export const optionDescription = (question: Question, index: number) =>
  question.kind === "select" ? question.options[index]?.description : undefined;

/** The tab in view. */
export const currentTab = (state: QnaState): Tab => {
  const question = state.questions[state.tab];
  const answer = state.answers[state.tab];
  if (question === undefined || answer === undefined) return { type: "context" };

  return answer.kind === "text"
    ? { type: "input", question, text: answer.text }
    : { type: "choice", question, answer };
};

/** Whether the cursor is on the row where the user types their own answer. */
export const isOtherRow = (state: QnaState) => {
  const tab = currentTab(state);

  return (
    tab.type === "choice" && tab.question.kind === "select" && state.row === otherRow(tab.question)
  );
};

const otherRow = (question: Question) => optionLabels(question).length;

const rowCount = (question: Question) =>
  question.kind === "select" ? otherRow(question) + 1 : optionLabels(question).length;

const isAnswered = (answer: Answer) => {
  if (answer.kind === "text") return answer.text.trim() !== "";
  return answer.picked !== undefined && (answer.picked !== "other" || answer.other.trim() !== "");
};

/** Whether the question at `index` has an answer. */
export const isAnsweredAt = (state: QnaState, index: number) => {
  const answer = state.answers[index];
  return answer !== undefined && isAnswered(answer);
};

/** The row of the answer picked on a tab, or the first row when none is. */
const pickedRow = (question: Question, answer: ChoiceAnswer) => {
  if (answer.picked === undefined) return 0;
  return answer.picked === "other" ? otherRow(question) : answer.picked;
};

/** Goes to a tab, wrapping around the ends, with the cursor on the answer picked there. */
export const goTo = (state: QnaState, tab: number): QnaState => {
  const count = state.questions.length + 1;
  const next = ((tab % count) + count) % count;
  const answer = state.answers[next];
  const question = state.questions[next];

  const row = answer?.kind === "choice" && question !== undefined ? pickedRow(question, answer) : 0;

  return { ...state, tab: next, row, noting: undefined, isIncomplete: false };
};

export const moveRow = (state: QnaState, step: number): QnaState => {
  const tab = currentTab(state);
  if (tab.type !== "choice") return state;
  const row = Math.min(Math.max(state.row + step, 0), rowCount(tab.question) - 1);
  return { ...state, row, noting: undefined, isIncomplete: false };
};

const withAnswer = (state: QnaState, answer: Answer): QnaState => ({
  ...state,
  answers: state.answers.map((existing, index) => (index === state.tab ? answer : existing)),
});

/** Picks the option under the cursor and goes on to the next tab. */
export const pick = (state: QnaState): QnaState => {
  const tab = currentTab(state);
  if (tab.type !== "choice" || isOtherRow(state)) return state;
  return goTo(withAnswer(state, { ...tab.answer, picked: state.row }), state.tab + 1);
};

/** Sets the text of the typed answer, the input tab or Additional Context, as the user types. */
export const typeText = (state: QnaState, text: string): QnaState => {
  const tab = currentTab(state);
  if (tab.type === "context") return { ...state, context: text };
  if (tab.type === "input") return withAnswer(state, { kind: "text", text });

  const { picked } = tab.answer;

  if (text.trim() === "") {
    return withAnswer(state, {
      ...tab.answer,
      other: text,
      picked: picked === "other" ? undefined : picked,
    });
  }

  return withAnswer(state, { ...tab.answer, other: text, picked: "other" });
};

/**
 * Enter on a text field: an answered input or typed answer goes on to the next tab. Additional
 * Context is not handled here; it sends.
 */
export const acceptText = (state: QnaState): QnaState =>
  isAnsweredAt(state, state.tab) ? goTo(state, state.tab + 1) : state;

/** Opens the note of the option under the cursor. The typed answer and input tabs take none. */
export const startNote = (state: QnaState): QnaState => {
  const tab = currentTab(state);
  if (tab.type !== "choice" || isOtherRow(state)) return state;
  return { ...state, noting: state.row };
};

/** The note being typed, or undefined when none is open. */
export const noteText = (state: QnaState) => {
  const tab = currentTab(state);
  if (tab.type !== "choice" || state.noting === undefined) return;
  return tab.answer.notes[state.noting] ?? "";
};

/** Saves the note being typed; an empty note removes it. */
export const saveNote = (state: QnaState, text: string): QnaState => {
  const tab = currentTab(state);
  if (tab.type !== "choice" || state.noting === undefined) return state;
  const { [state.noting]: _removed, ...others } = tab.answer.notes;
  const notes = text.trim() === "" ? others : { ...others, [state.noting]: text.trim() };
  return { ...withAnswer(state, { ...tab.answer, notes }), noting: undefined };
};

export const dropNote = (state: QnaState): QnaState => ({ ...state, noting: undefined });

/** The answers as the message to the model, or the first open question when one has no answer. */
export const send = (state: QnaState): Sent => {
  const open = state.answers.findIndex((answer) => !isAnswered(answer));

  if (open !== -1)
    return { type: "incomplete", state: { ...goTo(state, open), isIncomplete: true } };

  return { type: "answers", text: answersText(state) };
};

const answersText = (state: QnaState) => {
  const lines = state.questions.flatMap((question, index) => {
    const answer = state.answers[index];
    if (answer === undefined) return [];

    return [
      `${index + 1}. ${question.prompt} ${answerLine(question, answer)}`,
      ...noteLines(question, answer),
    ];
  });

  const context = state.context.trim();

  return ["Answers:", ...lines, ...(context === "" ? [] : [`Additional context: ${context}`])].join(
    "\n",
  );
};

const answerLine = (question: Question, answer: Answer) => {
  if (answer.kind === "text") return answer.text.trim();
  if (answer.picked === "other") return answer.other.trim();
  return optionLabels(question)[answer.picked ?? 0] ?? "";
};

const noteLines = (question: Question, answer: Answer) => {
  if (answer.kind === "text") return [];
  const labels = optionLabels(question);

  return Object.entries(answer.notes).map(
    ([index, note]) => `   Note on ${labels[Number(index)] ?? ""}: ${note}`,
  );
};
