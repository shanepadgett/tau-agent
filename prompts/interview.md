---
description: Interview the user one question at a time until shared understanding is complete
argument-hint: "<topic>"
---

Run a structured interview about: $ARGUMENTS

The argument is the interview subject. If it is empty, ask for the subject before setup.

Ask only one question at a time.

First search `.agents/interviews/` for a matching interview. If one exists, ask whether to resume it or start fresh. For a resume, read `decisions.md`, `open-questions.md`, and `scratchpad.md`; briefly restate the goal, exit condition, and current state; then continue at the next open question.

For a fresh interview:

1. Confirm the interview goal: what user and agent must agree on.
2. Confirm the exit condition: which resolved decisions mean the interview is done. Keep it separate from the goal.
3. Derive a concise kebab-case slug only after the goal and exit condition are confirmed. Create `.agents/interviews/<slug>/` with:

```markdown
# decisions.md

## Goal

<what must be understood>

## Exit Condition

<what must be resolved for the interview to end>

## Decisions

- None yet.
```

Create `open-questions.md` for unresolved questions that surface and `scratchpad.md` for useful ideas, observations, and things to revisit that fit neither decisions nor open questions. `decisions.md` contains concrete, confirmed, fully reconciled decisions only. It is never a Q&A log.

Question loop:

1. Pick the most important open question or unresolved point toward the exit condition. Inspect relevant material first when it informs the question. Findings do not settle a decision without user agreement.
2. Ask exactly one question. Use yes/no for binary decisions. Use multiple choice only for a known complete set of valid alternatives: list every genuinely valid option, whether that means two or ten. Do not pad the list, add decoys, or omit a valid path. Use open-ended questions when the user's framing matters.
3. Give a recommendation after the question or options. Explain the tradeoff in one or two sentences. Compare real tradeoffs when several choices are good.
4. The user may think aloud, explore, or raise another topic. Respond and explore when useful. Capture legitimate new questions in `open-questions.md` and useful ideas in `scratchpad.md`, then return to the current question.
5. Update a record only when new information belongs in it: concrete confirmed decisions in `decisions.md`; unresolved questions in `open-questions.md`; useful remainder in `scratchpad.md`. Do not edit records merely because a response arrived.
6. If a response contradicts a decision, surface and reconcile the conflict before recording it. Revise or remove stale decisions, or reopen the point. If the correct resolution is unclear, leave it open.
7. If the goal or exit condition shifts, confirm the shift with the user and update `decisions.md`.

Finish only when the exit condition is met and `open-questions.md` is empty. Sweep `scratchpad.md` for final questions or decisions, summarize `decisions.md`, and confirm shared understanding. Do not chase unrelated edge cases after that.
