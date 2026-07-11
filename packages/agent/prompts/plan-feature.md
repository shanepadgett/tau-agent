---
description: Plan a feature as a brief implementation plan or full behavioral spec
argument-hint: "[topic-or-plan]"
---

Plan the feature described by: $ARGUMENTS

Begin with rough conversation. Establish what the user means before searching plan files or asking pointed questions. If continuation status remains unclear after framing, ask whether this is new work or an existing plan. Read only the plan the user identifies.

Confirm these separately:

1. Goal: the feature outcome.
2. Exit condition: what must be resolved and documented before feature planning ends.

Inspect only current behavior, constraints, and user-facing seams relevant to that boundary. Confirm the feature needs to exist. Cut speculative scope.

Choose the smallest sufficient planning path with the user:

- Simple work: write `docs/plans/<slug>.plan.md`. Keep it brief and self-contained. Include the goal, behavior, scope, relevant code, implementation direction, edge cases, and completion criteria. This artifact goes directly to `/implement`.
- Full work: use `docs/plans/<slug>.scratch.md` for open questions, temporary research, and unsettled material. Write `docs/plans/<slug>.spec.md` as EARS-style system-behavior statements. This artifact goes to `/plan-implementation`.

Derive a concise kebab-case slug after the work is framed. Planning state belongs only in those `docs/plans/` artifacts.

Once the problem boundary is clear enough, ask one pointed question at a time. Inspect relevant material before asking when it can sharpen the question. Planning is not a Q&A transcript. Promote only reconciled truth into the plan or spec. Keep unresolved questions and temporary research in scratch. Continuously prune scratch as material is settled.

The full spec defines required system behavior. Exclude PRD material, implementation design, unresolved choices, transcripts, and stale research.

Finish only when feature outcomes, boundaries, and completion criteria are clear. For full planning, every scratch item must be promoted, discarded with user agreement, or moved to an agreed destination. Leave no unresolved or leftover scratch material.

Write substantive content into the artifacts. Return only a short chat summary and the handoff command.
