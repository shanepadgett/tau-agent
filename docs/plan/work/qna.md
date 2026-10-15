# `/qna`

Status: built; checks pending. Waiting for a live check. Guide: [qna.md](../../guide/qna.md).

Built differently from the mockups: Tab and Shift+Tab switch tabs from every tab, and the hint lines of text fields show `tab next` instead of `←→ tab`, because Left and Right move the cursor in a text field. Esc on the typed-answer row clears its text first. Multi-select and a skip-submit key from `main` are not built.

**How it works:** `/qna` sends a prompt with `RunOptions.askQuestions`, which gives the model the `ask_question` tool. A valid call saves the questions in the tool result's details, and the loop's `stopAtQuestions` operation ends the run with `questions-asked`. The chat opens the panel on that event, and sends the answers as the next prompt.

Code: `session/Questions.ts`, `core/internal/questions/ask-question-tool.ts`, `core/internal/loop/stop-at-questions.ts`, `tui/internal/qna-state.ts`, `qna-flow.ts`, `QnaPanel.tsx`.

`/qna [context]` makes the model ask its open questions in a panel the user answers.

## Decisions

- **Trigger:** the user only. Typing `/qna` starts it. The model never opens the panel on its own mid-turn.
- **Tool scope:** the `ask_question` tool exists for the `/qna` turn only. It is absent from every other turn and from the cached prefix.
- **Question types:** select, input and confirm first. Multi-select waits for the multi-select picker (see `questions.md`).
- **Answers:** when the panel closes, the answers go back to the model as one user message, including the Additional Context text.
- **Notes:** on a select or confirm tab, `n` on any real option opens a one-line note for that option; the note goes to the model with the answer. Notes are per option and are kept even when another option is picked. Input tabs, the `Other…` row, and the Context tab take no notes: on those, `n` is a typed letter.
- **Cancel:** Escape discards everything; the model gets nothing.
- **Recommendations (2026-10-15, built):** a question may carry an optional `recommendation: { answer, reason }`. The reason is required whenever there is a recommendation. For select and confirm, `answer` must be the label of one option (`Yes` or `No` for confirm); for input it is the suggested text. A call that breaks this is rejected, and the model corrects it.
- **Question tracker:** not part of this. It is a separate feature (`features.md`).
- **Built-in:** `/qna` is a built-in, written for Tau directly. It is not designed around the extension SDK.

## From `main`

`/qna [context]` turned on an `ask_question` tool and had the model ask its last questions again in a panel (select, multi, input, confirm, plus an Additional Context tab).

## Mockups (approved)

The panel sits where the `/model` picker sits, above the input, and closes when the flow ends. Text in parentheses is muted. `⠋` is the spinner. `✓` marks an answered tab; the current tab is bracketed. Today `/qna` is not a command; the input sends it to the model as a prompt.

1. After `/qna`: the model is rebuilding its questions. No panel yet; the chat shows the run as usual, and the input is locked as in any run. Esc cancels the run.

```
› /qna
⠋ Working…
```

2. Select question. Up and Down choose; Enter picks and moves to the next tab. Left and Right (or Tab) switch tabs without answering. The last row, `Other…`, is always there; Enter on it turns the tab into the input line of mockup 4, and the typed text is the answer. Confirm questions have no `Other…` row.

```
┌Questions──────────────────────────────────────┐
│[1] 2  3  Context                              │
│                                               │
│Which store should hold sessions?              │
│                                               │
│› SQLite (one file, already a dependency)      │
│  JSON files (simple, slow to search)          │
│  Postgres (needs a server)                    │
│  Other…                                       │
└enter pick · ←→ tab · esc cancel───────────────┘
```

3. Confirm question. Same list with two fixed rows.

```
┌Questions──────────────────────────────────────┐
│✓1 [2] 3  Context                              │
│                                               │
│Should old sessions be deleted after 90 days?  │
│                                               │
│› Yes                                          │
│  No                                           │
└enter pick · ←→ tab · esc cancel───────────────┘
```

4. Input question. Typing fills the line; Enter accepts and moves on. An empty Enter leaves it unanswered.

```
┌Questions──────────────────────────────────────┐
│✓1 ✓2 [3] Context                              │
│                                               │
│What should the retention folder be called?    │
│                                               │
│> sessions-archive█                            │
└enter accept · ←→ tab · esc cancel─────────────┘
```

5. Additional Context tab, always last. Optional. Enter on this tab submits.

```
┌Questions──────────────────────────────────────┐
│✓1 ✓2 ✓3 [Context]                             │
│                                               │
│Anything else the model should know? (optional)│
│                                               │
│> █                                            │
└enter send answers · ←→ tab · esc cancel──────┘
```

6. Enter on the Context tab while a question is unanswered: the panel stays open, jumps to the first unanswered tab, and shows a warning line.

```
┌Questions──────────────────────────────────────┐
│✓1 [2] ✓3 Context                              │
│                                               │
│Should old sessions be deleted after 90 days?  │
│                                               │
│  Yes                                          │
│  No                                           │
│Answer every question before sending.          │
└enter pick · ←→ tab · esc cancel───────────────┘
```

### Notes (awaiting approval)

Same panel as mockup 2. The footer hint shows `n note` only where `n` opens a note.

2a. Select tab, cursor on a real option: `n` is offered.

```
┌Questions──────────────────────────────────────┐
│[1] 2  3  Context                              │
│                                               │
│Which store should hold sessions?              │
│                                               │
│› SQLite (one file, already a dependency)      │
│  JSON files (simple, slow to search)          │
│  Postgres (needs a server)                    │
│  Other…                                       │
└enter pick · n note · ←→ tab · esc cancel──────┘
```

2b. After `n`: the line under the option becomes an input. Enter saves the note; Esc drops it and goes back to the list (a second Esc cancels the panel). An empty save deletes the note.

```
┌Questions──────────────────────────────────────┐
│[1] 2  3  Context                              │
│                                               │
│Which store should hold sessions?              │
│                                               │
│› SQLite (one file, already a dependency)      │
│  └─ > must work offline█                      │
│  JSON files (simple, slow to search)          │
│  Postgres (needs a server)                    │
│  Other…                                       │
└enter save note · esc drop note────────────────┘
```

2c. Saved note, option picked (`✓`). The note shows under its option in muted text, whether or not the option is picked.

```
│✓1 [2] 3  Context                              │
│                                               │
│› SQLite (one file, already a dependency) ✓    │
│  └─ must work offline                         │
│  JSON files (simple, slow to search)          │
│  └─ maybe, if the file stays small            │
│  Postgres (needs a server)                    │
│  Other…                                       │
```

2d. Cursor on `Other…`: typing any letter, `n` included, opens the typed answer inline. No `n note` in the hint.

```
│  Postgres (needs a server)                    │
│› > nats-backed store█                         │
└enter save · esc drop · ←→ tab─────────────────┘
```

The answer message (mockup 7) lists each note after its answer:

```
  1. Which store should hold sessions? SQLite
     Note on SQLite: must work offline
     Note on JSON files: maybe, if the file stays small
```

7. Sent. The panel closes. The chat shows the answers as a user message and the model replies:

```
› Answers:
  1. Which store should hold sessions? SQLite
  2. Delete old sessions after 90 days? Yes
  3. Retention folder name? sessions-archive
  Additional context: keep it under 200 lines.
```

8. Lines for the other endings, in the warning color:

```
  /qna cancelled. Nothing was sent.
  The model had no questions to ask.
  Could not start /qna: <error>
```

### Recommendations (approved)

Two muted lines under the options (select, confirm) or under the prompt (input), as on `main`. The cursor still starts on the first row; the recommended option is not marked.

```
┌Questions──────────────────────────────────────┐
│[1] 2  3  Context                              │
│                                               │
│Which store should hold sessions?              │
│                                               │
│› SQLite (one file, already a dependency)      │
│  JSON files (simple, slow to search)          │
│  Postgres (needs a server)                    │
│  Other…                                       │
│                                               │
│Recommendation: SQLite                         │
│Reason: already a dependency, no new service.  │
└enter pick · n note · ←→ tab · esc cancel──────┘

┌Questions──────────────────────────────────────┐
│✓1 ✓2 [3] Context                              │
│                                               │
│What should the retention folder be called?    │
│                                               │
│Recommendation: sessions-archive               │
│Reason: matches the existing archive naming.   │
│                                               │
│> █                                            │
└enter accept · tab next · esc cancel───────────┘
```

A long reason wraps onto more lines. The answers message (mockup 7) does not change.

## Still to design

- The `ask_question` tool schema and how the turn enables it.
- Where the panel and answer message live in `core/`, `session/` and `tui/`.
- Guide page `docs/guide/qna.md`.
