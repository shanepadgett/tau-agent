# Codex Priority

Requests Codex priority processing (Fast mode) for every `gpt-6-luna` request on the `openai-codex` provider: the agent loop, `/compact` summaries, tool approval, auto-naming, commit, and handoff. Priority gives faster responses at a higher credit rate, so the approval reviewer and compaction block you for less time.

There is no command and no setting. Other models are unchanged. Displayed cost uses OpenAI's documented 2.5x Fast mode rate for GPT-6 models.

Do not run another extension that overlays the `openai-codex` provider or sets `service_tier`; the one that loads last wins.
