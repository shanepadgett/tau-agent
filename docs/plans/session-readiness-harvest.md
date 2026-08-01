# Session readiness harvest

Prompt (or thin extension later). Human triggers it after a session worth learning from.

## Intent

Bottle what the session revealed about **agentic readiness of the repo**, not a generic retro and not a dump of chat into docs.

Good triggers: hard problem finally cracked, repeated footgun, agent thrashed then found the real module, validations/tools behaved in a surprising way, human corrected taste more than once, multi-chat feature left scaffolding behind.

## What it reads

- Current session trajectory (goals, dead ends, final path)
- Existing rails: AGENTS.md, standards, context packs, tasks, markers, cold start
- What the agent actually ran (verify, publish, ad-hoc bash)

## What it proposes (short, actionable)

Only repo-facing improvements, each with a landing place:

- New or tighter lint/entropy rule
- Standard doc gap or split (UI vs API etc.)
- AGENTS.md one-liner only if truly always-on
- Context pack / vocabulary update
- Cold-start or task-runner gap
- `@agent` markers to add (temp/until/invariant) on leftover scaffolding
- Deterministic verb (slash command/script) for a procedure that was re-derived
- Taste replay: human rejection → micro-rule text

## What it must not do

- Rewrite constitution unprompted
- Inflate AGENTS.md with session-specific lore
- Inline full standards into always-on policy
- “Add more comments” as a default recommendation
- Commit or apply without human accept

## Output shape

1. Session lesson in a few sentences (what was hard / what worked)
2. Numbered proposals: change, why, where it lives, effort rough size
3. Explicit “do nothing” options when the rails already cover it
4. Optional: ordered apply plan if human says go

## Delivery

v1: project prompt e.g. `/harvest-readiness` or `/ready-harvest` that instructs the coding agent to analyze this session against the agent-ready checklist.

Later: optional UI to accept/reject proposals and open patches only for accepted items.
