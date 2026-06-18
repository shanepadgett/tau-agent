# Clarify Extension

Structured user clarification for blocked agent decisions.

## Commands

`/qna` temporarily enables `clarify` and sends a hidden instruction asking the agent to re-ask its last question with structured UI.

`/interview [topic]` creates `.working/interviews/<timestamp>-<slug>/decisions.md`, enables interview tools, and sends a hidden instruction to run a structured interview.

Interview sessions keep `clarify` active across turns. The agent updates the decisions file after each answer, confirms the exit condition with the user, then calls `interview_end`.

## Tools

Registers `clarify`, inactive by default. It is enabled for `/qna`, then disabled after `clarify` returns or the agent turn ends.

During `/interview`, `clarify` stays active and `interview_end` is also exposed. `interview_end` only ends the active interview; it does not write the decisions file.

Use only when missing user intent, preference, or constraint would materially change the next action. Supports:

- `select`: one option or custom answer
- `multi`: multiple options plus optional custom answer
- `input`: free-form typed answer
- `confirm`: fixed yes/no

Selectable questions require real options, recommendation values, and an honest recommendation reason. User can add notes to real options.

## UI

- Answered question tabs get a `•` suffix. Tabs are hidden for single-question panels.
- `select` and `confirm` render as pointer lists, with `✓` on the selected answer.
- `multi` renders checkboxes.
- `input` uses Pi's native single-line input.
- Custom answers edit inline: move to "Type your own answer..." and type.
- Notes render under option descriptions with `└─`.
- `tab`/`←→` moves between questions.
- `enter` advances and submits from the last question. `ctrl+s` submits anytime; unanswered questions are skipped.
- Results render as a Markdown-style numbered question/answer list.

## Layout

- `index.ts`: Pi registration, schema, prompt guidance, renderers
- `model.ts`: validation, normalized state, result building
- `ui.ts`: custom TUI component

## Skipped

No settings, replay, persistence, notifications, or preview panes. Add when usage proves need.
