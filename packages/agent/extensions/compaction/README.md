# Compaction

Writes compaction summaries with a cheaper model from the same provider as the session, so long Opus, GPT-6.1 Sol, and Astra sessions do not pay their own rates to summarize themselves.

Compaction, `/compact`, and overflow recovery use the `quick` effort tier for the session's provider (for example `gpt-6-luna` for OpenAI Codex and `claude-sonnet-5-5` for Anthropic). Summaries never cross providers. A notice names the model that wrote each summary, and the saved compaction entry is marked `fromHook: true`. File lists from earlier compactions are carried forward. When the session model is already the quick model, the provider has no quick model, the quick model's context window is too small for the conversation, or every quick model fails, Pi's default compaction runs with the session model.
