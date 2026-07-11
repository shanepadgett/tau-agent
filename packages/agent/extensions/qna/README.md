# qna Extension

Structured question UI for blocked agent decisions.

## Commands

`/qna [context]` temporarily enables `ask_question` and sends a hidden instruction asking the agent to re-ask its last question with structured UI. Optional context is included as framing guidance for the question.

## Tools

Registers `ask_question`, inactive by default. It is enabled for `/qna`, then disabled after `ask_question` returns or the agent turn ends.

Use only when missing user intent, preference, or constraint would materially change the next action. Supports:

- `select`: one option or custom answer
- `multi`: multiple options plus optional custom answer
- `input`: free-form typed answer
- `confirm`: fixed yes/no

Selectable questions require real options, recommendation values, and an honest recommendation reason. User can add notes to real options.

Every panel includes a final user-owned `Additional Context` tab. It is not part of the tool schema. Non-empty text returns as top-level `additionalContext`.

## UI

- Question tabs get a `•` suffix when answered. The final `Additional Context` tab gets `•` when it has text.
- The final `Additional Context` tab is always present and uses Pi's native single-line input.
- `select` and `confirm` render as pointer lists, with `✓` on the selected answer.
- `multi` renders checkboxes.
- `input` uses Pi's native single-line input.
- Custom answers edit inline: move to "Type your own answer..." and type.
- Notes render under option descriptions with `└─`.
- `tab`/`←→` moves between questions and additional context.
- `enter` advances through questions and submits from additional context. `alt+enter` submits anytime; unanswered questions are skipped.
- Results render as a Markdown-style numbered question/answer list, plus an additional context section when supplied.

## Layout

- `index.ts`: Pi registration, schema, prompt guidance, renderers
- `model.ts`: validation, normalized state, result building
- `ui.ts`: custom TUI component

## Skipped

No settings, replay, persistence, notifications, interview workflow, or preview panes. Add when usage proves need.
