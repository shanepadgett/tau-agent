# Decisions

Uses Jev or Luna classifiers to approve routine bash and eval requests early, remind the agent to answer questions before working, and choose a model for the kind of work.

All features are on by default. Set `extensions.decisions.enabled` to `false` to turn them off, or disable `approval`, `answerFirst`, or `routing` individually. `classifier` accepts `auto` (Jev first, then Luna), `jev`, or `luna`. Missing credentials and failed decisions fall back without stopping work.

Routing uses only ChatGPT and Claude subscription logins. It chooses on the first prompt and after compaction; choosing a model yourself stops automatic routing for that session. The footer shows `auto:<route>` and the classifier as `provider/model` beside the main model. Configure route descriptions, models, and thinking levels under `extensions.decisions.routing.routes`.
