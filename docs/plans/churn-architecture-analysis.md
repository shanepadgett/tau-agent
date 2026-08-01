# Churn → architecture analysis (Tau)

Marker plan. Not scheduled. Enough detail to remember the idea.

## Intent

High-churn areas often mean missing boundaries, shallow modules, or feature soup. Give Tau a way to surface churn hotspots and ask a structured question: would a different module cut reduce churn and improve modularity?

Not a calendar “roulette.” Not mandatory refactors. Signal + guided analysis when the human wants it.

## Rough shape

- Performant churn signal: git history (e.g. frequency of touch per path over a window), maybe weighted by agent sessions later if cheap. Cache aggregates; do not grind full history every keystroke.
- Cluster related hot paths (same directory, co-changed files).
- Present hotspots in a Tau UI or command (`/churn` or part of `/ready`).
- On request, run an architecture-oriented pass (review-style or subagent): current ownership, dependency edges, whether a deeper module / slice split / extension point would isolate change.
- Output is advisory: proposed boundaries, risks, leave-it rationale. Human decides.

## Non-goals

- Auto-refactor
- Time-based nagging (“weekly ownership spin”)
- Scoring developers
- Replacing entropy tools (complexity/dup still do their job)

## Open questions

- Git-only vs include agent edit telemetry
- Default window and thresholds
- How this relates to context packs (hotspot without a pack = smell?)
- Package monorepos vs single app layout
