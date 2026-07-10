# Soul Mode Removal Interview Decisions

## Goal

Agree on removing Soul modes, maximizing stable prompt-prefix caching, and defining feature-planning, implementation-planning, and implementation-execution prompt behavior.

## Exit Condition

Soul's remaining responsibilities, all mode-removal cleanup, and the exact purpose, workflow, guidance, artifacts, and handoffs of the three replacement prompts are agreed.

## Decisions

- Soul will own only Rok's system prompt, runtime/project context assembly, and its `enabled` setting.
- Delete every mode command, state entry, marker, renderer, footer item, and mode-context hook. Keep no dormant mode machinery.
- Feature planning chooses between a small plan ready for direct implementation and a full feature-planning flow that produces working notes plus an EARS feature spec, then hands off to implementation planning.
- Planning artifacts live under `docs/plans/`.
- Simple feature planning writes `docs/plans/<slug>.plan.md`.
- Full feature planning writes `docs/plans/<slug>.scratch.md` and `docs/plans/<slug>.spec.md`.
- Full feature and implementation planning share `docs/plans/<slug>.scratch.md`. Keep it continuously pruned as material is promoted into the spec or technical plan.
- Implementation planning writes `docs/plans/<slug>.technical.md`.
- A planning stage cannot finish while scratch material or open questions remain unresolved. Promote settled material, discard it with agreement, or move unrelated ideas to an agreed destination.
- Full-plan open questions live in `docs/plans/<slug>.scratch.md`; no separate open-questions file.
- Implementation planning finishes only when `technical.md` is complete, the shared scratch file is empty, and a fresh implementation chat can execute it without basic design questions.
- Feature planning finishes only when its simple plan or full spec is complete, feature outcomes and boundaries are clear, and full-plan scratch content is fully reconciled.
- Planning prompts write substantive plan content into files and return only short chat summaries. They do not restate the plan in chat.
- Feature and implementation planning begin with rough conversational framing and alignment. Pointed interviewing starts only after the problem boundary is defined enough to sharpen.
- Both planning prompts then confirm a goal and separate exit condition, choose and derive their artifacts, and ask one pointed question at a time.
- The replacement prompts are `prompts/plan-feature.md`, `prompts/plan-implementation.md`, and `prompts/implement.md`, invoked as `/plan-feature`, `/plan-implementation`, and `/implement`.
- The planning prompts borrow the interview discipline but keep planning-specific research and synthesis. They store state only in `docs/plans/`, not `.agents/interviews/`.
- Planning is not a Q&A transcript: inspect relevant material before questions, use findings to sharpen decisions, and promote only reconciled truth into final plan artifacts.
- Feature planning researches current behavior, constraints, and user-facing seams. Implementation planning researches code ownership, repository patterns, dependencies, refactor opportunities, and concrete implementation paths.
- Soul's core prompt retains only guidance that applies in every chat. Feature-planning, implementation-planning, and execution workflow guidance moves into the respective prompt.
- `/plan-feature` owns Code Ladder rung 1 (`Need exist?`) and feature-scope discipline. `/plan-implementation` owns rungs 2–8 and Design It Twice.
- `technical.md` records the chosen design and serious alternatives, exact files and ownership, data/control flow, reuse and refactors, deletions, implementation order, edge cases, validation, and exact code references where useful.
- `technical.md` must let a less-capable implementation agent execute cleanly without spelling out every line of code.
- `/implement` requires either `<slug>.plan.md`, or both `<slug>.spec.md` and `<slug>.technical.md`. Invoking `/implement` for those artifacts is approval to execute them. It stops on conflicts or missing decisions, implements the artifacts exactly, and cleans replaced code.
- `/implement` stays intentionally thin: resolve and read the identified artifacts, obey their boundaries and order, stop on contradiction, make the changes, remove stale code, and report only non-obvious caveats.
- Soul core keeps only persona/voice, user authority and scope, safety, context-reading discipline, and concise interaction. Code design, Code Ladder, refactoring, file shape, mutation, cleanup, and execution guidance moves into the three prompts.
- Full feature specs describe required system behavior rather than PRDs.
- `/plan-implementation` works only from `<slug>.spec.md`. Simple `<slug>.plan.md` goes directly to `/implement`.
- Planning prompts do not search or read plan files before rough conversational framing establishes what the user means.
- After rough framing, ask whether work is new or continues an existing plan only when that is unclear. Read only the plan the user identifies.
- Repository research stays tightly grounded in the framed work. Do not explore unrelated plans or code.
- A simple `<slug>.plan.md` stays brief but includes enough behavior, scope, relevant code, implementation direction, edge cases, and completion criteria for direct implementation. Ask only the few feature or technical validation questions the small change needs.
- Every plan artifact is a self-contained handoff. A fresh chat must be able to run the next planning or implementation prompt without relying on omitted conversation context.
