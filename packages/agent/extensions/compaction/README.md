# Compaction

Writes compaction summaries with a cheaper model from the same provider as the session, so long Opus, GPT-6.1 Sol, and Astra sessions do not pay their own rates to summarize themselves.

Self-compaction is on by default. The agent sees a notice at 100,000 tokens, a warning at 150,000, and a hard cutoff at 200,000, capped below the active model's context window and Pi's own compaction threshold. Notice is informational: active work continues. Warning asks the agent to finish its current bounded work unit, then compact before starting another substantial unit. Each newly reached stage is delivered once per checkpoint, appended without changing preceding conversation. At the hard cutoff only `self_compact` is allowed.

The agent supplies a short current handoff (aim for 500–1,500 characters; maximum 24,000), preserved verbatim once inside a checkpoint alongside summarized durable context. The checkpoint replaces all earlier raw conversation in the next request; the transcript stays on disk. A run that finishes at warning or forced without compacting gets one hidden reminder. Notice alone never starts an extra turn. Prompts are built into Tau.

Configure `extensions.compaction.selfCompact` with `enabled`, `noticeTokens`, `warningTokens`, and `forcedTokens`. Settings changes take effect at startup or after `/reload`. Setting `enabled` to `false` disables self-compaction: the `self_compact` tool and its instructions are absent, and `/compact`, automatic compaction, and overflow recovery use Pi's built-in summary format and configured recent-token retention, still generated with quick models. Saved pending handoffs remain on disk but do not lock tools, retry, route models, or start extra turns while disabled. The footer continues showing context usage.

When enabled, an animated indicator above the editor shows self-compaction and handoff preparation; native triggers keep Pi's indicator. The footer shows context usage and thresholds. Automatic model routing may switch models after compaction unless you chose the model yourself.

Quick-model summary selection is independent of self-compaction and stays active in both modes. All compaction triggers use the `quick` effort tier for the session's provider (for example `gpt-6-luna` for OpenAI Codex and `claude-haiku-5-5` for Anthropic), then the session model if no cheaper model fits or succeeds. Summaries never cross providers. A notice names the summary model. File lists carry forward.

With self-compaction enabled, self-compaction, `/compact`, threshold compaction, and overflow recovery use the same checkpoint format and one complete-history summary request on success. With it disabled, Pi chooses the retained boundary and handles its own summary format, including split-turn summaries.

Failed self-compactions retain the handoff and tool lock; Tau retries three times, then retries on the next run or `/compact`. Failed checkpoints from native triggers fall back to Pi's default compaction with a warning that recent raw history was retained. A pending handoff is delivered separately after that fallback.
