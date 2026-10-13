# Decisions

Uses Jev or Luna classifiers to approve routine bash and eval requests early, remind the agent to answer questions before working, and choose a model for the kind of work.

All features are on by default. Set `extensions.decisions.enabled` to `false` to turn them off, or disable `approval`, `answerFirst`, or `routing` individually. `classifier` accepts `auto` (Jev first, then Luna), `jev`, or `luna`. Missing credentials and failed decisions fall back without stopping work.

Routing uses only ChatGPT and Claude subscription logins. It chooses on the first prompt and after self-compaction; choosing a model yourself stops automatic routing for that session. Disabling decisions or routing also disables post-compaction routing. The stats widget above the editor shows the classifier as `Jev` or `Luna` beside the main model when available.

`quick` uses Luna at max or Haiku at high for bounded repository questions, investigation, fixes, and planning within existing patterns. `general` uses Sol or Sonnet at high for substantial engineering, deep investigation, and ordinary architecture planning. Frontend implementation and `simple-design` prefer Sonnet, including whole pages within an established design system. Writing uses Sonnet at medium.

`complex-design` reserves Opus for new design systems, fundamentally new interaction models, demanding multi-screen workflows, or exceptional creative ambition with substantial open-ended scope. `architecture` reserves Opus for major unresolved constraints and unusually difficult architectural decisions. Page size and words such as “creative” or “architecture” alone do not justify Opus.

Among a route's peer candidates, routing favors the provider used less relative to its target. Defaults target OpenAI-to-Anthropic usage of 2:1 over a rolling 24 hours. Configure `extensions.decisions.routing.balance.windowHours` and `balance.providerWeights` (`openai-codex` and `anthropic`) to change these preferences. Configured candidate order breaks ties and applies when accounting is unavailable. Balancing does not reorder lower-priority fallback routes.

Usage is estimated from local Pi session records and their reported costs, including cache pricing and recorded Fast-mode surcharges. It is not remaining subscription allowance and misses activity outside Tau. Only usage explicitly attributed to `openai-codex` or `anthropic` affects balancing; other providers and unattributed helper usage remain in cost totals but do not affect provider preference. Frontend's Sonnet preference and Opus's difficulty requirements remain independent of usage.

Configure route descriptions and ordered `candidates` under `extensions.decisions.routing.routes`. Each candidate requires `provider`, `model`, and `thinking`; a candidates list replaces the default list in full. The former route-level model fields must be replaced with this shape:

```json
{
  "extensions": {
    "decisions": {
      "routing": {
        "routes": {
          "quick": {
            "candidates": [
              { "provider": "openai-codex", "model": "gpt-6-luna", "thinking": "max" },
              { "provider": "anthropic", "model": "claude-haiku-5-5", "thinking": "high" }
            ]
          }
        }
      }
    }
  }
}
```

Settings changes require `/reload`.
