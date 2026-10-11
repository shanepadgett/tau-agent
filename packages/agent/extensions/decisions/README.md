# Decisions

Uses Jev or Luna classifiers to approve routine bash and eval requests early, remind the agent to answer questions before working, and choose a model for the kind of work.

All features are on by default. Set `extensions.decisions.enabled` to `false` to turn them off, or disable `approval`, `answerFirst`, or `routing` individually. `classifier` accepts `auto` (Jev first, then Luna), `jev`, or `luna`. Missing credentials and failed decisions fall back without stopping work.

Routing uses only ChatGPT and Claude subscription logins. It chooses on the first prompt and after compaction; choosing a model yourself stops automatic routing for that session. The footer highlights the selected work type before the main model and shows the classifier as `provider/model` beside it when available. Configure route descriptions, models, and thinking levels under `extensions.decisions.routing.routes`.

`simple-design` uses Sonnet for bounded component design, including creative alternatives and redesigns. `complex-design` uses Opus for substantial whole-page design, multi-screen experiences, design systems, and major interaction changes across a workflow. Creative requests alone do not justify Opus; uncertain design requests prefer Sonnet.
