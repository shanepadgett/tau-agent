# Budget Awareness

## Goal

Give Tau private budget, cache, and turn-pressure awareness so the agent spends fewer high-cost turns and batches work better.

This extension observes and advises. It does not prune context or rewrite tool results.

## V1 scope

- Inject ephemeral agent-only budget notes before model calls.
- Report context usage from `ctx.getContextUsage()`.
- Track turn count and tool-call batching pressure.
- Track recent tool-result count and approximate text size.
- Surface recent usage/cost/cache signals from assistant usage metadata when available.
- Classify cache state as hot, cold, or unknown using provider/model policy and last provider request time.
- Encourage batching, focused reads, cleanup checkpoints, or compaction when pressure is high.
- Add a tiny outbound tail note only when the last context message is a `toolResult` and pressure is high.

No context pruning, no tool superseding, no persisted hidden message spam, no automatic keepalive pings.

## Product behavior

Hidden note example:

```text
Budget note:
- context: 63% of 200k
- cache: likely cold; last provider request 9m ago, short-retention Anthropic model
- turn pressure: high; batch reads/checks before answering
- suggestion: use focused reads and cleanup tools before next expensive reasoning pass
```

The note is injected only into outbound context. It is not appended to session history.

Inside an active tool loop, prefer appending a small note to the last outbound `toolResult` instead of adding a new message:

```text
<budget-note>context 63%; 9 recent tool results / ~18k chars; batch remaining reads/checks before answering.</budget-note>
```

Skip the note when the last message is not a `toolResult` unless Pi offers a safe system/prompt hook that does not disturb role ordering.

## Tool-result pressure

Compute cheap signals from the current outbound message list:

- count recent successful tool results since the last user message
- approximate text characters in those results
- count tool calls since the last assistant text-only response
- detect large single outputs

Do not parse tool semantics. Do not decide what is stale. That belongs to `working-memory`.

Guidance examples:

- high recent tool-output size: batch remaining inspection before answering
- high context percent and cold cache: use cleanup/checkpoint tools before the next expensive reasoning pass
- hot cache and low pressure: avoid churn; continue current batch

## Cache policy facts

Provider facts to encode as defaults/configurable policy:

- Anthropic short cache: 5 minute TTL, 1.25x cache write, 0.1x cache read.
- Anthropic long cache: 1 hour TTL, 2x cache write, 0.1x cache read.
- OpenAI cached input: automatic for supported prompts, commonly 0.1x cached input; short in-memory retention is roughly 5-10 minutes, long retention can be 24h where supported.
- Gemini explicit cache: default TTL around 1 hour; implicit cache is less deterministic.

Cache state:

- `hot`: last provider request is inside known short TTL.
- `cold`: last provider request exceeds known TTL.
- `unknown`: provider/model retention is unavailable or ambiguous.

Cache guidance:

- Hot cache: avoid unnecessary prefix churn; batch nearby work.
- Cold cache: cleanup before the next call is usually safer because the old prefix is likely gone anyway.
- Long-retention cache: prefer fewer pings; use provider retention when available.

## Keepalive economics

Keepalive pings resend the cacheable prefix. They are cheap on a cache hit, not free.

Anthropic short-cache rough math:

```text
ping/read cost = 0.1x cached prefix
miss rewrite cost = 1.25x cached prefix
break-even p(return) > ping_count * 0.1 / 1.15
```

Examples:

```text
1 ping  (~5m):  return chance must be > 9%
3 pings (~15m): return chance must be > 26%
6 pings (~30m): return chance must be > 52%
10 pings (~50m): return chance must be > 87%
```

Anthropic 1h cache write costs 0.75x more than short write. It beats repeated pings when a long pause and later return are likely enough.

## Future simulator

Build a read-only analysis command or script that replays real session JSONL and compares policies:

- raw session
- deterministic cleanup
- compaction thresholds
- short cache with no pings
- short cache with keepalive pings
- long cache retention

Outputs:

- estimated dollars
- max context percent
- cache read/write tokens
- cold-cache gaps
- turns saved/lost to compaction or pings

This simulator belongs here because it evaluates budget policy. It should not implement pruning rules.

## Non-goals

- No stale-read/grep detection.
- No `forget` tool.
- No tool result stubbing or replacement.
- No assistant-message pruning.
- No code map.
- No automatic provider pings in v1.

## Open decisions

- Hidden note only, or optional footer/status display too.
- Exact turn metric: user turns, provider requests, assistant turns, or tool batches.
- Whether cache policy should be configurable per provider/model.
- Whether keepalive should ever be automatic or only manually requested.

## Files/ranges to reread if needed

Pi source/docs:

- `/Users/shanepadgett/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js` lines 2405-2449: `getContextUsage()`.
- `/Users/shanepadgett/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/dist/core/sdk.js` lines 190-225: provider payload/context hooks.
- `/Users/shanepadgett/.bun/install/global/node_modules/@earendil-works/pi-ai/dist/api/anthropic-messages.js` lines 15-32 and 894-910: cache retention/control.
- `/Users/shanepadgett/.bun/install/global/node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js` lines 70-80 and 418-430: OpenAI cache retention params.

External references:

- Anthropic prompt caching docs: `https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching`
- OpenAI prompt caching guide: `https://developers.openai.com/api/docs/guides/prompt-caching`
- Aider caching docs: `https://aider.chat/docs/usage/caching.html`
