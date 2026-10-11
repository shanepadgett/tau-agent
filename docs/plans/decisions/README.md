# Decision models

Tau uses classifier ("decision") models for fast, structured choices that should not need a chat-model call. Each feature has its own plan. All of them share one runtime.

| Plan | What it decides | Fallback when no decision is available |
| --- | --- | --- |
| [00 Runtime](00-runtime.md) | Shared classifier client, settings, and failure rules | Not applicable |
| [01 Approval pre-filter](01-approval.md) | Run a bash or eval request now, or defer it to the reviewer | Defer to the reviewer |
| [02 Model routing](02-routing.md) | Model and thinking level from the kind of work, on the first prompt and after each compaction | `general` route |
| [03 Answer first](03-answer-first.md) | Whether to remind the agent to answer and stop before working, and to ask again any questions left unanswered | No reminder |
| [04 Context management](04-context.md) | Not a decision-model feature: the agent compacts itself through a tool, with notice, warning, and forced thresholds | Pi's own threshold compaction |

The evidence is in [research.md](research.md).

## Implementation status

The decisions runtime, approval pre-filter and reviewer alignment, routing, answer-first reminders, self-compaction, footer integration, and separate decision-cost reporting are wired. Extension code requires `/reload` before live testing. Final provider-payload cache diagnostics, the 3,000-character answer-first benchmark, labeled unanswered-question pairs, and routing accuracy evaluation remain validation work; the earlier benchmarks do not establish those results.

Live use of the initial implementation confirmed answer-first guidance, self-compaction and exact note delivery, and routing on the resumed request. The revised [04 Context management](04-context.md) is now wired: a unified checkpoint with no retained raw conversation, an animated progress indicator above the editor, and a three-row footer. This revision still needs `/reload` and live provider-payload, recovery, routing, and UI validation. When a Tau checkpoint fails outside self-compaction, Pi's default compaction remains the fallback and Tau warns that recent history was retained.

## Shared decisions

- **Model:** OpenRouter `~typesafe/jev-latest` through Pi's `ModelRegistry.classify()`. In testing it was the best overall and used no local memory.
- **No local model:** d3-nano needs about 9.3 GB of memory and a 3.6-minute startup. It took 0.8–2 s per decision on Apple GPUs, against 0.2 s for Jev, and it was weaker on answer-first detection.
- **Only allowed outcomes:** a decision model may approve something early or adjust a choice. It never escalates to the user or blocks work. Errors, timeouts, refusals, missing credentials, and oversized input all take the feature's fallback.
- **On by default:** the `decisions` settings object has one master switch and one switch per feature. Missing Jev and Luna credentials are not an error; each feature then behaves as Tau does today.
- **No new tests:** validation reuses the spike harness against session history and live use, following repository policy.
