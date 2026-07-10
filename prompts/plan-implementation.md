---
description: Turn a feature spec into an executable technical design
argument-hint: "[slug-or-spec-path]"
---

Plan implementation for: $ARGUMENTS

Begin with rough conversational framing. Establish what the user means before searching plan files. If continuation status remains unclear after framing, ask which work to continue. Read only the plan the user identifies.

Require one `docs/plans/<slug>.spec.md`. Stop if it is missing, contradictory, or leaves feature behavior undecided. Simple `docs/plans/<slug>.plan.md` artifacts go directly to `/implement`.

Confirm these separately:

1. Goal: the technical design to produce.
2. Exit condition: what must be resolved before a fresh implementation chat can execute it.

Reuse `docs/plans/<slug>.scratch.md` for open questions, repository findings, and temporary design work. Research only the framed feature's code ownership, callers where needed, repository patterns, dependencies, refactor opportunities, and concrete implementation paths. Ask one pointed question at a time after the boundary is clear. Continuously promote settled material and prune scratch.

Climb the Code Ladder. Stop at the first rung that satisfies the spec cleanly:

1. Reuse code or a repository pattern that already exists.
2. Make a small refactor first when it removes special cases or makes the change safer and clearer.
3. Use the standard library.
4. Use the native platform.
5. Use an existing dependency.
6. Use one line when one line is clear and correct.
7. Otherwise, write the smallest code that works.

For non-trivial structure, design it twice. Compare the current or first viable shape with at least one serious alternative. Choose by concrete ownership, control flow, change surface, and failure behavior.

Keep implementation shape plain. Every file, function, class, interface, setting, command, and abstraction must earn its boundary through naming, reuse, or a simpler caller. Avoid one-implementation interfaces, one-product factories, empty wrappers, fixed-value configuration, and scaffolding for hypothetical work. Prefer focused files whose names make repository search useful. Refactor only where it reduces the planned change or removes special cases.

Write `docs/plans/<slug>.technical.md` with:

- Goal and completion condition.
- Chosen design plus serious alternatives and tradeoffs.
- Exact files and owners.
- Data and control flow.
- Existing code to reuse and any required refactors.
- Replaced code and resources to delete.
- Implementation order.
- Edge cases and boundaries.
- Validation.
- Exact code references where useful.

Make it self-contained and precise enough for a less-capable agent without prescribing every line of code.

Finish only when no basic design question remains, `technical.md` can guide a fresh implementation chat, and every scratch item has been promoted, discarded with user agreement, or moved to an agreed destination. Leave no unresolved or leftover scratch material.

Write substantive content into the artifacts. Return only a short chat summary and the `/implement` handoff.
