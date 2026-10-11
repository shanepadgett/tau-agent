# 03 Answer first

## Goal

The agent gets a hidden reminder after the user's prompt in two cases:

- **Answer first:** the prompt asks a question, mixes a question with work, or asks the agent to hold off. The reminder says to answer first, then stop.
- **Open questions:** the agent's previous message asked questions that this prompt leaves unanswered, for example 3 of 5 answered. The reminder says to ask the remaining questions again.

The reminder is the whole feature. Tau does not block tools or check whether the agent complied.

## Architecture

`answer-first.ts` in the `decisions` extension uses two Pi events:

```text
input (interactive, idle, not a slash command) ──▶ start classify(answerFirst)
before_agent_start ──▶ await ──▶ stop? ──▶ return { message: reminder }
```

- `before_agent_start` returns `message: { customType: "tau.answer-first", content, display: false }`. Pi places it after the user prompt.
  - The cached prefix should be unchanged, because the reminder goes at the end. Confirm with `cache-diagnostics` on the final payload.
- Starting the call on `input` overlaps classifier latency, about 0.2 s, with Pi's own pre-run work.
- Steering and follow-up messages sent while the agent is streaming are skipped.
- No decision means a normal run with no reminder.

## Classification

State: `{ previous_agent_message_end: last 3,000 chars of the latest assistant text, prompt }`.

The tail grew from 600 to 3,000 characters so it covers a full list of questions. Before shipping, re-run the answer-first benchmark with the longer tail to check that `kind` accuracy holds.

One call asks two questions. The second, `unanswered`, is asked only when the previous message contains `?`.

### `kind` (choice)

"What is the user's prompt to the coding agent asking for?"

| Option | Meaning |
| --- | --- |
| `question` | Information, an explanation, an opinion or recommendation, whether something is possible or advisable (`is there a way`, `could we`, `should we`, `why`), or confirmation that the agent understood, with no work requested |
| `question_and_work` | A real question, an understanding check, or pushback phrased as a question, together with requested work |
| `hold` | Asks the agent to hold off, not start yet, or wait until decisions are agreed |
| `work` | Work only, including polite requests phrased as questions (`can you run the tests?`) or "answer then go ahead" |
| `continue` | Approval, an answer, or a continuation of the agent's proposal (`yes`, `go ahead`), or ideas and decisions shared without asking anything |

Rule: answer first when `P(question) + P(question_and_work) + P(hold) >= 0.5`.

Research on 130 hand-labeled prompts, with Jev:

- All 81 prompts that should stop were caught.
- 5 of the 49 prompts that should proceed would have stopped. All 5 are arguable, such as statements ending in `right?` or `correct?`.
- All 11 prompts from this session were handled correctly.

### `unanswered` (bool)

"Did the agent's previous message ask the user questions that this prompt leaves unanswered?"

- **True:** the previous message asked one or more questions or asked for decisions, and the prompt answers only some or none of them.
- **False:** no questions were asked; the prompt answers all of them; the prompt explicitly sets them aside; or the prompt changes direction so they no longer apply.

Rule: carry questions forward when `P(unanswered) >= 0.5`.

A classifier returns probabilities, not text, so the reminder cannot list the open questions. The agent finds them in its own previous message.

Validation: there is no labeled data yet. Before shipping, label about 50 real pairs from session history: an assistant message with questions, followed by the user's reply. Include full, partial, and dismissed answers.

## Reminder

One hidden message, built from the parts that apply.

Answer first:

```text
The user's message asks a question or asks you to hold off. Answer first.
You may read files and run read-only commands to answer accurately.
Do not edit files, run state-changing commands, or start the requested work.
End with one line saying what you would do next, then stop and wait.
```

Open questions:

```text
Your previous message asked questions the user has not answered yet.
At the end of your reply, ask the unanswered ones again.
```
