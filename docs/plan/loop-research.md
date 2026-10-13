# Agent loop research

Status: research for build steps 4 and 5, 2026-10-13. The vocabulary and the slice 4a changes are agreed.

Nine agents were read for how they run a loop, build context, cache prompts and keep long sessions going: Goose, OpenCode, Codex, Grok Build, Pi (agent and durable), oh-my-pi, Mastra, DeepSeek Harness and the AI SDK. Tau's plan holds up. The research adds three safety rules to slice 4a and several ideas for later steps.

## Vocabulary (agreed)

The references use the same words for different things. Codex calls the whole response to a prompt a "turn"; Pi calls one model reply a "turn"; the AI SDK and OpenCode call that a "step". Tau uses:

```text
session ─ entries ─ runs ─ turns ─ model calls
```

| Term | Meaning | Elsewhere |
| --- | --- | --- |
| Session | One saved conversation in one working directory | Codex and Mastra: thread; Pi durable: conversation |
| Branch | A new session that starts with a copy of another session up to a chosen entry | Pi: fork |
| Entry | One saved record in a session: a prompt, a reply, a tool result, an instructions update, a summary | Pi: entry; Codex: rollout item |
| Prompt | What the user submits | |
| Run | Everything Tau does for one prompt, until it answers, fails or is stopped | Pi: run; Codex: turn |
| Turn | One model reply and the tool calls it makes | Pi: turn; AI SDK, OpenCode: step |
| Model call | One request to a model; a turn makes more than one when a call is retried | OpenCode: physical attempt; Codex: sampling request |
| Step | One pass of the loop: read the entries, try the operations in order, save what the first one produces | Goose: step |
| Operation | One rule the step tries, such as "run open tool calls" or "call the model" | Goose: operation |
| Steering message | A message sent during a run; it joins the run after the current turn | Pi, OpenCode: steer |
| Follow-up | A message sent during a run that waits for the run to end, then starts a new run | Pi: follow-up; Mastra: queued message |
| Context | What the model sees on one model call, built from the entries | |
| Instructions | Guidance other than the base prompt, such as `AGENTS.md`, the date and the environment; a change is saved as an entry | Codex: world state; DeepSeek: prompt context |
| Compaction | Replacing older context with a summary entry; the older entries stay saved | |
| Event | Live progress, such as text as it streams; not saved | |
| Interrupted | A reply or tool call cut short by the user or a crash | |

Tau calls the loop the "agent loop", because it runs a whole run, not one turn.

## What the references confirm

| Tau decision | Same design in |
| --- | --- |
| Each step reads saved entries; nothing lives between steps | Goose state machine; OpenCode ("the runner never delegates orchestration to an in-memory tool loop"); Pi durable generation phases |
| Instructions are saved as changes, shown once at the point they changed | OpenCode instruction deltas; Pi durable `pi.system` section patches; Codex world-state sections (`render_diff`); DeepSeek `PromptContext` (a user-role snapshot after history); Mastra state signals |
| Compaction folds instructions back into the system prompt | Pi durable writes a full baseline after each compaction; Mastra reinserts a state snapshot once the old one leaves context |
| A branch copies entries up to its point | OpenCode forks; DeepSeek fork seeds; Pi durable `parent.at` |
| Background compaction, with a blocking threshold | Pi durable; Mastra observational memory buffering |

## Changes for slice 4a (agreed)

1. **Record a tool call as started before it runs.** OpenCode and Pi durable save intent first. On restart, a call that started and has no result gets an "interrupted" result and is never run again, because a script's effects cannot be undone. Without this, Tau's step function would rerun a half-finished script after a crash. Moves from 4b to 4a.
2. **The context view repairs tool history** (Pi durable's rules): each tool result goes right after its call; a call with no result gets an error result (an interrupted run, or a branch cut between a call and its result); a result with no call is dropped.
3. **Save the text of an interrupted reply,** marked interrupted. It stays in the session for the user and is left out of later model calls (Pi durable, OpenCode).
4. **An optional turn limit per run, off by default.** Goose (`MaxTurnsOperation`), OpenCode (an agent-step allowance that new user input resets) and the AI SDK (`stopWhen`) cap the loop by default. Tau does not: long runs are normal, and the model ends a run with its final answer. A `maxTurns` setting turns a limit on.

## Ideas for later steps

| Idea | From | Step |
| --- | --- | --- |
| Retries: at most four, jittered backoff, honour the provider's retry delay; a retry before any saved output does not start a new turn | OpenCode | 4b |
| A reply cut at the output limit ends the run as "max tokens", so the user can tell it from a clean answer | DeepSeek, oh-my-pi | 4b |
| Overflow: compact once and retry; a second overflow fails the run | OpenCode, Pi durable | 5 |
| Rewrite earlier context only when the cache is cold anyway: after an idle gap longer than the cache lifetime, on a model change, or at compaction | Mastra early activation; oh-my-pi cache-aware pruning | 5 |
| Rolling memory instead of one-shot compaction: summarize older messages in small background chunks, swap them in at a threshold, condense the summaries when they grow | Mastra observational memory (30k messages, 40k observations) | 5 |
| Warn the model as the window fills, and let it save notes before compaction | Codex token-budget reminders and pre-compaction prompt | 5 |
| Save very large tool output to a file and give the model its path | DeepSeek spill storage; oh-my-pi artifacts | 4c |
| Claude cache breakpoints: end of system prompt, last message, and the user message before the previous reply; keep the fourth slot free | Grok Build | 4b |
| Keep the system message ahead of the first prompt, so a later instruction change does not move the cached prefix | Pi durable | 4b |

**Mastra's observational memory, in short.** A background Observer turns old messages into short dated notes every few thousand tokens. When raw history reaches 30k tokens, the notes replace the oldest 80% of it. When the notes reach 40k tokens, a Reflector rewrites them into a shorter set. Raw history moves between about 6k and 30k tokens, and the notes stay near 40k tokens however long the session runs. The cost is complexity: Mastra's own architecture notes list more than ten lost-message and race bugs across storage adapters. Tau has one SQLite store and one writer per session, which removes most of those races.

**Pi durable, in short.** Everything visible is saved first: entries, task records and documents commit together, and nothing is published before it is saved. A run is a chain of durable tasks (`prepare`, `request`, `retry`, `tools`). Queued input waits in an inbox and is placed only at two boundaries: after tools and at the end of a run. Compaction summaries are queued writes, so a slow summary that an earlier cut has overtaken is dropped as stale.

## Sources

`goose/crates/goose-agent/README.md`, `goose/crates/goose/src/agents/agent.rs`; `opencode/specs/v2/session.md`; `codex/codex-rs/core/src/session/turn.rs`, `context/world_state/`, `session/token_budget.rs`; `grok-build/crates/codegen/xai-grok-sampling-types/src/conversation/messages.rs`, `xai-grok-agent/src/system_reminder.rs`; `pi/packages/agent/README.md`, `pi/packages/durable/docs/spec.md` (sections 1, 2.1, 6, 7.4, 8.3–8.7); `oh-my-pi/docs/compaction.md`, `non-compaction-retry-policy.md`, `blob-artifact-architecture.md`; `mastra/packages/memory/src/processors/observational-memory/ARCHITECTURE.md`, `mastra/docs/src/content/en/docs/memory/observational-memory.mdx`, `docs/guides/context-engineering.mdx`, `docs/harness/`; `deepseek-harness/docs/subsystems/session.md`, `system-prompt.md`, `compaction.md`, `spill.md`; `ai/architecture/stream-text-loop-control.md`.
