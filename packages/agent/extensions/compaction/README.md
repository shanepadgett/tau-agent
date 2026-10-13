# Compaction

Writes compaction summaries with a cheaper model from the same provider as the session, so long Opus, GPT-6.1 Sol, and Astra sessions do not pay their own rates to summarize themselves.

Self-compaction is on by default. The agent sees a notice at 100,000 tokens, a warning at 150,000, and a hard cutoff at 200,000, capped below the active model's context window and Pi's own compaction threshold. Notice is informational: active work continues. Warning asks the agent to finish its current bounded work unit, then compact before starting another substantial unit. Each newly reached stage is delivered once per checkpoint, appended without changing preceding conversation. At the hard cutoff only `self_compact` is allowed.

The agent supplies a short current handoff (aim for 500–1,500 characters; maximum 24,000), preserved verbatim once inside a checkpoint alongside summarized durable context. A self-compaction checkpoint replaces all earlier raw conversation in the next request; the transcript stays on disk. Manual, threshold, and overflow compaction keep the recent messages selected by Pi's configured `keepRecentTokens` setting. A run that finishes at warning or forced without compacting gets one hidden reminder. Notice alone never starts an extra turn. Prompts are built into Tau.

Configure `extensions.compaction.selfCompact` with `enabled`, `noticeTokens`, `warningTokens`, and `forcedTokens`. Settings changes take effect at startup or after `/reload`. Setting `enabled` to `false` disables self-compaction: the `self_compact` tool and its instructions are absent, and `/compact`, automatic compaction, and overflow recovery use Pi's built-in summary format and configured recent-token retention, still generated with quick models. Saved pending handoffs remain on disk but do not lock tools, retry, route models, or start extra turns while disabled. The footer continues showing context usage.

When enabled, an animated indicator above the editor shows self-compaction and handoff preparation; native triggers keep Pi's indicator. The footer shows context usage and thresholds. Automatic model routing may switch models after compaction unless you chose the model yourself.

Quick-model summary selection is independent of self-compaction and stays active in both modes. All compaction triggers use the `quick` effort tier for the session's provider (for example `gpt-6-luna` for OpenAI Codex and `claude-haiku-5-5` for Anthropic), then the session model if no cheaper model fits or succeeds. Summaries never cross providers. A notice names the summary model. File lists carry forward.

Only `self_compact` uses the durable-context checkpoint with an agent-written handoff and replaces the complete raw history. Manual, threshold, and overflow compaction use Pi's normal summary format and retained boundary in both modes, without requiring or generating a self-compaction handoff. Earlier messages and any split-turn prefix go into the summary, while recent messages stay raw.

Self-compaction uses Pi's normal structured summary and output-token budget, then appends the saved handoff verbatim once. It does not require JSON output or enforce a character limit on the summary. Partial summaries are never saved. Transient provider failures follow Pi's configured retry policy.

Failed self-compactions retain the handoff and tool lock; the next run can retry. `/compact` can also recover: it keeps recent history and delivers the saved handoff separately afterward. Failed quick-model summaries from native triggers fall back to Pi's default compaction.
