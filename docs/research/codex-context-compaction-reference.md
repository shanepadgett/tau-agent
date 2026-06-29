# Codex Context and Compaction Reference

Reference repo: `/Users/shanepadgett/.local/share/tau-agent/references/codex`

## Scope

Focused read of Codex context management, context windows, and compaction.
Main implementation is in `codex-rs/core/src/`, with public protocol pieces in
`codex-rs/protocol/src/`, app-server wiring in `codex-rs/app-server*`, and TUI
entry points in `codex-rs/tui/src/`.

## Core Model

Codex treats the active conversation as a mutable `ContextManager`:

- `core/src/context_manager/history.rs`
  - Stores oldest-to-newest `ResponseItem`s.
  - Tracks `history_version`, token usage, a `reference_context_item`, and a
    `world_state_baseline`.
  - Records only API-visible messages. System messages and `CompactionTrigger`
    are not durable history.
  - Truncates function/custom tool outputs as they enter history.
  - Normalizes prompt history before model calls by fixing call/output pairs and
    stripping images when unsupported.
  - Estimates token use for items after the last server token sample, reasoning,
    encrypted compaction items, images, and encrypted tool outputs.

The durable checkpoint object is `CompactedItem`:

- `protocol/src/protocol.rs`
  - `message`: summary text for legacy/display conversion.
  - `replacement_history`: optional full replacement transcript.
  - `window_number`, `first_window_id`, `previous_window_id`, `window_id`:
    context-window chain metadata.
- `protocol/src/compacted_item.rs`
  - Migrates old numeric `window_id` into `window_number` for old rollouts.

`Session::replace_compacted_history` is the installation boundary:

- `core/src/session/mod.rs`
  - Assigns item IDs when enabled.
  - Replaces in-memory history.
  - Persists `RolloutItem::Compacted` with replacement history.
  - Persists a full `WorldStateItem` and `TurnContextItem` when supplied.
  - Queues a `SessionStartSource::Compact` hook source.

## Context Injection and Baselines

Codex separates full initial context from steady-state context diffs.

- `Session::record_context_updates_and_set_reference_context_item`
  - If `reference_context_item` is missing, builds full initial context.
  - Otherwise appends only settings/world-state diffs.
  - Persists a `TurnContextItem` per real user turn so resume can recover the
    latest baseline even when no visible diff was emitted.
- `Session::build_initial_context_with_world_state`
  - Builds developer and contextual-user sections from permissions,
    collaboration mode, model/personality settings, app connectors, world state,
    extensions, and token-budget metadata.

Compaction affects this baseline:

- Manual and pre-turn compaction use `InitialContextInjection::DoNotInject`.
  They clear the reference baseline; the next normal turn reinjects full context.
- Mid-turn compaction uses `InitialContextInjection::BeforeLastUserMessage`.
  It injects fresh full initial context into replacement history before the last
  real user message, because the model is trained to see the compaction summary
  as the last item after mid-turn compaction.
- `insert_initial_context_before_last_real_user_or_summary` prefers insertion
  before the last real user message, then before a summary, then before a
  compaction item, then append.

## Auto-Compact Windows

Window state lives in `core/src/state/auto_compact_window.rs`.

It tracks:

- Monotonic `window_number`.
- UUIDv7 chain: first, previous, current window IDs.
- Pending `new_context` request flag.
- `prefill_input_tokens` for scoped token-budget accounting.
- Whether a token-budget reminder has already been delivered for this window.

`advance()` increments the window number, moves current ID to previous ID, and
creates a new current UUID. `start_new_context_window()` also clears prefill.

`Session::current_window_id()` formats the request metadata window as
`<thread_id>:<window_number>`. Installed compaction checkpoints persist the UUID
chain separately.

## Token Limits and Trigger Conditions

Relevant config keys:

- `model_context_window`
- `model_auto_compact_token_limit`
- `model_auto_compact_token_limit_scope`
- `compact_prompt`
- `experimental_compact_prompt_file`
- `tool_output_token_limit`
- `features.token_budget.*`

Model metadata can also define `context_window`, `max_context_window`,
`auto_compact_token_limit`, and `comp_hash`.

Default auto-compact limit is 90% of the resolved model context window when no
explicit model limit is set. Explicit model limits are clamped to 90% of the
context window.

`core/src/session/context_window.rs` computes `ContextWindowTokenStatus`:

- `active_context_tokens`: full active context usage.
- `auto_compact_scope_tokens`: charged usage for the configured scope.
- `auto_compact_scope_limit`: limit for auto-compaction.
- `full_context_window_limit`: hard usable full-window limit.
- `tokens_until_compaction`.
- `token_limit_reached`.

Scopes:

- `total`: charges full active context.
- `body_after_prefix`: subtracts the current window prefill baseline and charges
  only growth after carried prefix. It still respects the full context-window
  limit.

Auto-compaction happens in `core/src/session/turn.rs`:

- Pre-sampling: compact if token limit is already reached.
- Pre-sampling before model switch: compact using the previous model when
  `comp_hash` changes or when downshifting to a smaller context window that
  cannot fit the current history.
- Mid-turn: after a sampling request, if the model needs follow-up or there is
  queued user input, compact when the token limit is reached or the model called
  `new_context`.

Manual compaction is `/compact`:

- TUI dispatch: `tui/src/chatwidget/slash_dispatch.rs`
- Core op handler: `core/src/session/handlers.rs`
- Task: `core/src/tasks/compact.rs`
- App-server RPC: `thread/compact/start`

## Compaction Implementations

Codex has four compaction paths.

### 1. Local Responses Summarization

Files:

- `core/src/compact.rs`
- `prompts/templates/compact/prompt.md`
- `prompts/templates/compact/summary_prefix.md`

Mechanism:

1. Add the compact prompt as synthetic user input.
2. Run a normal Responses model turn with request kind `compaction`.
3. Drain stream until `response.completed`, recording output items.
4. Extract the last assistant message as the summary suffix.
5. Build summary text as `SUMMARY_PREFIX + "\n" + suffix`.
6. Collect real user messages from prior history, excluding older summary
   messages.
7. Keep recent user messages under `COMPACT_USER_MESSAGE_MAX_TOKENS` = 20,000,
   truncating the oldest selected overflow message if needed.
8. Create replacement history as selected user messages plus a final user-role
   summary message.
9. Advance window, optionally inject fresh initial context, install checkpoint,
   recompute tokens, and emit a warning about long threads/multiple compactions.

The default compact prompt asks for a concise handoff summary with current
progress, key decisions, constraints, remaining work, and critical references.

If local compaction itself exceeds the context window, Codex removes the oldest
history item and retries. If only one item remains, it marks token usage as full
and returns `ContextWindowExceeded`.

### 2. Remote `/responses/compact`

Files:

- `core/src/compact_remote.rs`
- `core/src/client.rs`

Mechanism:

1. Clone current history.
2. Rewrite large function/custom/tool-search outputs to a fixed message when
   needed to fit the compact endpoint:
   `Output exceeded the available model context and was truncated`.
3. Build a prompt with current tools and base instructions.
4. Call unary endpoint `/responses/compact` through `compact_conversation_history`.
5. Receive a replacement `Vec<ResponseItem>` from the server.
6. Filter server output through `should_keep_compacted_history_item`.
7. Optionally inject fresh initial context.
8. Install checkpoint and recompute token usage.

Remote filtering drops stale or unsafe categories:

- Drops developer messages returned by the server.
- Drops user messages that are not real user messages or hook prompts.
- Keeps assistant messages, agent messages, `Compaction`, and
  `ContextCompaction`.
- Drops tool calls/outputs, reasoning, web/image/search calls, extra tools, and
  `CompactionTrigger`.

### 3. Remote Compaction V2

File: `core/src/compact_remote_v2.rs`

Mechanism:

1. Clone and possibly rewrite history outputs as in remote v1.
2. Append `ResponseItem::CompactionTrigger {}` to the prompt input.
3. Stream a normal Responses request with request kind `compaction`.
4. Require exactly one emitted `ResponseItem::Compaction` item.
5. Build installed history from retained prompt messages plus that compaction
   item.
6. Retain only message roles `user`, `developer`, and `system`, then apply the
   same durable-output filter used by remote v1.
7. Truncate retained message text to `RETAINED_MESSAGE_TOKEN_BUDGET` = 64,000,
   preferring newest messages and preserving images.
8. Track retained image count, compaction output tokens, cached input tokens.
9. Install checkpoint and recompute token usage.

The `CompactionTrigger` item is a request control, not durable history.

### 4. Token-Budget New Context Window

File: `core/src/compact_token_budget.rs`

When `Feature::TokenBudget` is enabled, compaction skips summarization and
starts a new context window instead.

Mechanism:

1. Run pre-compact hooks.
2. Emit a `ContextCompaction` turn item.
3. `Session::start_new_context_window` advances the window and replaces history
   with fresh initial context for the new window.
4. Emit completion.
5. Run post-compact hooks.

This path is still modeled as compaction so hooks, UI lifecycle, and rollout
items see the same shape.

## Model-Visible Context-Window Tools

Token-budget mode exposes context-window guidance and tools.

Files:

- `core/src/context/token_budget_context.rs`
- `core/src/tools/handlers/get_context_remaining.rs`
- `core/src/tools/handlers/new_context_window.rs`

Injected developer context:

- `<context_window>` contains thread ID, first/current/previous context-window
  IDs, and optional notes MCP output.
- `<context_window_guidance>` contains configured guidance text.

Tools:

- `get_context_remaining`: returns remaining tokens until compaction, or null.
  The model-visible response is a developer fragment saying how many tokens are
  left in this context window.
- `new_context`: requests a new context window without summarizing conversation
  history. The request is consumed after the next sampling result if follow-up or
  queued input exists.

Token-budget reminders are inserted once per window when remaining tokens pass
the configured threshold.

## Hooks and Analytics

Hooks:

- `PreCompact`
- `PostCompact`

Both receive session ID, turn ID, subagent context, cwd, transcript path, model,
and trigger (`manual` or `auto`). A hook can stop compaction; Codex returns
`TurnAborted`.

Analytics event: `codex_compaction_event`

Fields include:

- trigger: `manual` or `auto`
- reason: `user_requested`, `context_limit`, `model_downshift`,
  `comp_hash_changed`
- implementation: `responses`, `responses_compact`,
  `responses_compaction_v2`
- phase: `standalone_turn`, `pre_turn`, `mid_turn`
- strategy: currently `memento`
- status: `completed`, `failed`, `interrupted`
- active tokens before/after
- retained images, summary tokens, cached input tokens when known

## Protocol and UI Surface

Response item types:

- `ResponseItem::Compaction`: encrypted compaction content from Responses.
- `ResponseItem::CompactionTrigger`: request-only control.
- `ResponseItem::ContextCompaction`: durable/lifecycle compaction item.

Turn item:

- `ContextCompactionItem` has an ID and maps to legacy
  `EventMsg::ContextCompacted`.

User surfaces:

- `/compact`: "summarize conversation to prevent hitting the context limit".
- App-server JSON-RPC: `thread/compact/start`.
- TUI shows context compaction lifecycle and clears token usage when manual
  compaction starts.

## Rollout Reconstruction

File: `core/src/session/rollout_reconstruction.rs`

Resume/fork reconstruction scans rollout items backward.

- The newest `RolloutItem::Compacted` with `replacement_history` becomes the
  base transcript checkpoint.
- Newer rollout suffix items replay on top of that checkpoint.
- Compaction clears any older `reference_context_item` unless a newer
  `TurnContextItem` in the same segment re-establishes it.
- Window metadata is restored from compacted items.
- World-state baseline is restored from persisted `WorldStateItem`s.

Consequence: compaction is not just a summary message. It is a durable history
rewrite checkpoint with its own context-window identity and baseline behavior.

## Practical Takeaways

- Codex has three summarizing paths plus one non-summarizing token-budget reset
  path.
- Compaction installs a replacement transcript, not a hidden side summary.
- Mid-turn compaction is special because replacement history must include fresh
  initial context before the last real user message while keeping compaction
  output last.
- Baselines matter as much as messages. `reference_context_item` and
  `world_state_baseline` decide whether future turns emit full context or diffs.
- Token accounting mixes server token usage with local estimates for unsampled
  history growth.
- `body_after_prefix` scope makes auto-compaction charge only growth after the
  current window prefix, but the full context window still caps safety.
- Remote compaction output is treated as untrusted enough to filter and reinject
  canonical local context.
