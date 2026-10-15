# Answer the model's questions with `/qna`

`/qna` makes the model ask its open questions in a panel, so you can answer them with a few keys instead of typing a reply.

1. In the chat, between runs, type `/qna` and press Enter. To frame the questions, add text after it, for example `/qna about the storage choice`.
2. The model asks its questions. A panel opens above the input with one tab per question and a last tab, Context.
3. Answer each question. Enter or keypad Enter on the Context tab sends the answers. Escape cancels and sends nothing.

## The panel

- **Select:** Up and Down move, Enter or keypad Enter picks the option and goes to the next tab. The last row, `Other…`, is a text field: type your own answer, then press Enter or keypad Enter.
- **Confirm:** a Yes and No list that works the same way.
- **Input:** type the answer and press Enter.
- **Context:** optional text for anything else the model should know. Enter sends.
- **Tabs:** Tab and Shift+Tab switch tabs. Left and Right do the same on a list. A check mark on a tab means it has an answer.
- **Notes:** on a select or confirm option, press `n` to add a one-line note, for example why you chose it. Enter saves the note and Escape drops it. A note stays on its option even when you pick another. The `Other…` row, input tabs and the Context tab take no notes; there `n` types a letter.
- **Recommendations:** the model may suggest an answer and give its reason. They show as `Recommendation:` and `Reason:` lines, the words in the normal color and the text muted, under the options, or under the prompt on an input tab. Nothing is picked for you.
- **Missing answers:** Enter on the Context tab with a question unanswered stays in the panel and jumps to that question.

## What the model gets

When you send, your answers go to the model as one message:

```
Answers:
1. Which store should hold sessions? SQLite
   Note on SQLite: must work offline
2. Delete old sessions after 90 days? Yes
Additional context: keep it under 200 lines.
```

The model has the question tool only on the run `/qna` starts. If it has no questions, the chat says so. Escape in the panel discards everything.
