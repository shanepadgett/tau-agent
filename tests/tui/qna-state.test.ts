/** The `/qna` panel's state: picking, typing, notes, and the message the answers make. */

import { expect, test } from "bun:test";
import {
  acceptText,
  currentTab,
  dropNote,
  goTo,
  isOtherRow,
  moveRow,
  pick,
  type Question,
  qnaState,
  saveNote,
  send,
  startNote,
  typeText,
} from "../../src/tui/internal/qna-state.ts";

const QUESTIONS: readonly Question[] = [
  {
    id: "store",
    prompt: "Which store?",
    kind: "select",
    options: [{ label: "SQLite" }, { label: "JSON" }],
  },
  { id: "old", prompt: "Delete old sessions?", kind: "confirm" },
  { id: "name", prompt: "Folder name?", kind: "input" },
];

test("picking an option answers the question and moves to the next tab", () => {
  const state = pick(moveRow(qnaState(QUESTIONS), 1));
  expect(state.tab).toBe(1);
  expect(state.answers[0]).toMatchObject({ picked: 1 });
});

test("the row after the options is the typed answer, and picking there does nothing", () => {
  const state = moveRow(moveRow(moveRow(qnaState(QUESTIONS), 1), 1), 1);
  expect(isOtherRow(state)).toBe(true);
  expect(pick(state)).toBe(state);
  expect(startNote(state)).toBe(state);
});

test("typing on the other row picks it, and clearing the text unpicks it", () => {
  const onOther = moveRow(moveRow(qnaState(QUESTIONS), 1), 1);
  const typed = typeText(onOther, "nats");
  expect(typed.answers[0]).toMatchObject({ picked: "other", other: "nats" });
  expect(typeText(typed, "").answers[0]).toMatchObject({ picked: undefined });
});

test("a note stays on its option when another option is picked, and an empty note removes it", () => {
  const noted = saveNote(startNote(qnaState(QUESTIONS)), " offline ");
  const picked = pick(moveRow(goTo(noted, 0), 1));
  expect(picked.answers[0]).toMatchObject({ picked: 1, notes: { 0: "offline" } });
  expect(saveNote(startNote(goTo(picked, 0)), "").answers[0]).toMatchObject({ notes: {} });
  expect(dropNote(startNote(qnaState(QUESTIONS))).noting).toBeUndefined();
});

test("sending with a question open goes to the first open question", () => {
  const sent = send(pick(qnaState(QUESTIONS)));
  expect(sent.type).toBe("incomplete");

  if (sent.type === "incomplete") {
    expect(sent.state.tab).toBe(1);
    expect(sent.state.isIncomplete).toBe(true);
  }
});

test("the answers become one message with notes and context", () => {
  let state = saveNote(startNote(qnaState(QUESTIONS)), "must work offline");
  state = pick(state);
  state = pick(state);
  state = typeText(goTo(state, 2), "sessions-archive");
  state = typeText(goTo(acceptText(state), 3), "keep it short");
  expect(currentTab(state).type).toBe("context");

  const sent = send(state);

  expect(sent).toEqual({
    type: "answers",
    text: [
      "Answers:",
      "1. Which store? SQLite",
      "   Note on SQLite: must work offline",
      "2. Delete old sessions? Yes",
      "3. Folder name? sessions-archive",
      "Additional context: keep it short",
    ].join("\n"),
  });
});
