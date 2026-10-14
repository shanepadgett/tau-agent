# Compaction research

Status: research for build step 5, 2026-10-13. The design chosen from it is in [work/compaction.md](work/compaction.md).

**Finding:** compaction pays for itself within a few steps once the context passes about 100k tokens, and every model call above a model's long-context price tier costs double. So the point to compact should come from price and quality, not from the model's window. Pi durable streamlines the conversation flow, as expected, but it waits for the window, so a 1M-token model would run to about 950k. Tau main compacts at sensible sizes, but it stops the agent to write a handoff. Mastra keeps more detail by summarizing small pieces in the background, at the cost of frequent cache misses.

## Tau main

Source: `packages/agent/extensions/compaction/` in the main Tau repo.

| Part | How it works |
| --- | --- |
| Thresholds | Absolute token counts: a notice at 100k, a warning at 150k, a forced cutoff at 200k. Each is capped at `min(window × 0.9, window − reserve − 1)`, so small windows still work |
| Who compacts | The agent. At the warning it finishes its current unit of work, then calls `self_compact` with a handoff (500–1,500 characters, at most 24k). At the cutoff, `self_compact` is the only tool it may call. If a run ends at the warning or past it, one hidden reminder asks for the handoff |
| What it keeps | The handoff word for word, plus a structured summary of everything before it. No recent raw entries are kept |
| Summary model | The provider's cheap "quick" model (for example `gpt-6-luna`, `claude-haiku-5-5`), falling back to the session model. It never crosses providers |
| Other paths | Manual, threshold and overflow compaction use Pi's built-in summary and keep `keepRecentTokens` of raw entries |

**Strengths:** sizes are absolute, so 1M-token windows never fill. The agent decides what matters next, so the handoff is accurate.

**Costs:** the agent stops its work to compact, and the reminder prompts change its behavior near the thresholds. Writing the handoff uses a model step. Dropping all raw entries loses recent tool output that the next step may need.

## Pi durable

Source: `packages/durable/docs/spec.md` in the Pi reference copy, sections 7 and 8.7.

| Part | How it works |
| --- | --- |
| Thresholds | Relative to the window only. Blocking threshold: `window − reserveTokens` (16,384). Background start: `backgroundTokens` (32,768) below it |
| Who compacts | A task. Above the background start, the model call that is about to happen starts a background compaction and does not wait. Above the blocking threshold, or after a "context too long" error, the call waits for a compaction it owns |
| What it keeps | `keepRecentTokens` (20,000) of recent entries, cut only before a user or assistant entry, never between a tool call and its result. Older summaries are summarized again with the history after them |
| Summary request | The session model, no tools, with the old entries serialized to text (`[User]: ...`, tool results cut to 2,000 characters). Cache retention is off, so the request pays full input price |
| Placement | A background summary is queued like any other write and placed when the conversation is idle or at the next boundary. Work done while it ran stays raw. A summary that a newer cut has passed is dropped. A `beforeCompact` hook can supply or decline the summary |

**Confirmed:** Pi durable does streamline the flow. The agent never learns that compaction is happening, never stops for it unless it reaches the blocking threshold, and keeps working while the summary runs.

**Corrections:** its thresholds ignore cost. With a 1M-token window, the background summary starts at about 951k, so every call before that pays to re-read a large context, often at the doubled long-context price. Its summary request is also the most expensive of the three options below, because it is uncached and uses the session model.

## Mastra

Source: `packages/memory/src/processors/observational-memory/` in the Mastra reference copy, mainly `ARCHITECTURE.md` and `constants.ts`.

| Part | How it works |
| --- | --- |
| Observer | A background model call turns new messages into short, dated observations. It runs every 6k tokens of new messages (20% of the 30k threshold) and reads only the new messages |
| Activation | When unobserved messages reach 30k, the observations written in advance replace them; about 20% stays raw. The agent usually waits for nothing |
| Reflector | When observations reach 40k, a second call compresses them, starting in the background at 50% |
| Recall | Raw messages stay in storage, and the agent can browse them |
| Placement | Observations go into separate system messages |

**Gains:** summarizing small pieces keeps more detail than one large summary. Each call reads only new messages, with a cheap model by default. The context stays around 30–70k. Recall recovers detail a note lost.

**Costs:** every activation rewrites the context from the observations onward, every 20–25k tokens. The architecture document lists 7 proven data-loss bugs and 9 other confirmed bugs, nearly all races between buffering, activation and reflection across processes and seven storage backends. It is built for chat assistants, not coding.

## Economics

Every model call re-reads the whole context. With a warm cache, that costs the cached-input price (about 10% of the input price) for every token, on every step. Compaction is a one-time cost: one summary request, plus writing the smaller context to the cache. After that, every step reads less.

Tau's catalog already has what this needs: `ModelProfile.price` (input, output, cache read, cache write) and `ModelProfile.longContextPrice.aboveTokens`.

### Long-context price tiers

From the bundled catalog (`src/ai/catalog-snapshot.json`, from models.dev). Above the tier, input costs double, and the higher price usually applies to the whole request, not only the tokens above it.

| Models | Tier starts at | Window |
| --- | --- | --- |
| OpenAI GPT-5.4 to GPT-6 | 272k | 1.05M |
| Anthropic Sonnet 4.5–4.6, Opus 4.6–4.7 | 200k | 1M |
| Google Gemini 2.5 Pro, 3.1 Pro | 200k | 1M |
| Anthropic Haiku 5.5 | 100k | 1M |
| ByteDance Seed models | 128k | 262k |

Web sources from 2026 say Anthropic dropped its long-context premium for 4.6 models in March 2026; models.dev still lists it. Either way, the catalog is the source Tau would read, and a settings override covers a wrong entry.

This is where the 100k–300k range comes from: every major provider's tier starts between 100k and 272k.

### Payback

The calculation below assumes a session where compaction keeps 20k recent tokens, a 4k summary and a 12k system prompt (36k after compaction). The saving per step is the cached reads that are no longer needed. The cost is the summary request plus the cache write. The prices are `gpt-5.6`; `sonnet-4.6` gives the same step counts within one.

| Context at compaction | Saved per step | Pi durable (uncached, same model) | Same model, cached prefix | Cheap model (Tau main) |
| --- | --- | --- | --- | --- |
| 50k | $0.006 | 59 steps | 50 steps | 34 steps |
| 100k | $0.026 | 18 steps | 12 steps | 8 steps |
| 150k | $0.046 | 13 steps | 7 steps | 4 steps |
| 200k | $0.066 | 11 steps | 5 steps | 3 steps |
| 300k | $0.106 | 9 steps | 4 steps | 2 steps |

At 282k with `gpt-5.6`, one step costs $0.23 instead of $0.11 because of the tier.

Three things follow:

1. Below about 50k, compaction does not pay, and it throws away detail for nothing.
2. From 100k, payback takes a handful of steps. A coding turn often takes dozens, so in money terms compacting at 100k–200k almost always wins. The real cost is lost detail, not money.
3. Crossing the price tier doubles the cost of every step, so the tier is a hard ceiling.

### Quality

Chroma's "Context rot" report (July 2025, 18 models including GPT-4.1, Claude 4 and Gemini 2.5) found that answers get less reliable as input grows, even when the task stays the same. This argues for compacting well before the window fills, independent of price. Tau has no measurement of its own yet.

## What the research led to

Background notes written often and applied only at a compaction the agent chooses, described in [work/compaction.md](work/compaction.md). Its budget is the smallest of `window − 16k`, the price tier and a 200k setting:

| Model | Window | Tier | Budget |
| --- | --- | --- | --- |
| `gpt-5.6` | 1.05M | 272k | 200k (setting) |
| `claude-sonnet-4-6` | 1M | 200k | 200k |
| `claude-haiku-5-5` | 1M | 100k | 100k |
| 128k model, no tier | 128k | none | 112k |

It takes the background flow from Pi durable, the absolute sizes and the agent's handoff from Tau main, and small incremental notes and recall from Mastra. Unlike all three, the notes are append-only and the context is ordered from most stable to least stable, so a compaction keeps the cache up to the last old note.
