# Silent command runner in-run follow-up

Status: planned

## Goal

Keep automatic check repair inside the active Pi run. A failed silent command should reach the agent as a queued follow-up before the run settles, preserving one effective system prompt across the repair tool call and its continuation.

## Problem

`silent-command-runner` currently waits for `agent_settled`, then sends its failure with `{ triggerTurn: true }`. Pi starts that custom-message turn through `AgentSession.sendCustomMessage()` rather than the normal prompt path, so `before_agent_start` does not run.

Pi 0.81 also refreshes the system prompt between tool turns. The settled run has already cleared `_systemPromptOverride`, which produces this sequence:

1. the failure turn's first provider request inherits the previous effective system prompt from `agent.state.systemPrompt`;
2. the agent calls `patch`;
3. Pi prepares the next tool turn from `_systemPromptOverride ?? _baseSystemPrompt`;
4. the cleared override drops Tau's extension-added system instructions;
5. the provider receives a different `instructions` prefix and cannot reuse the prior cache entry.

Cache diagnostics confirmed the mechanism in session `019f84e6-16a7-7968-a4fb-51cb4ed38880`. Between requests `:57` and `:58`, all 236 existing input items, the tool schemas, and `prompt_cache_key` remained unchanged. Only `instructions` changed. Cache read fell from 113,152 tokens to 1,536 tokens.

## Decision

Run matching commands from the awaited `agent_end` extension handler. Pi still considers the agent active while these handlers execute. When a command fails, send the existing custom failure message with `{ deliverAs: "followUp" }`.

Pi's `AgentSession._handlePostAgentRun()` explicitly checks for messages queued by `agent_end` handlers and calls `agent.continue()`. The repair therefore stays in the same `AgentSession._runAgentPrompt()` chain, before `_systemPromptOverride` is cleared and before `agent_settled` is emitted.

Do not mutate provider payloads or add a synthetic user message. Those workarounds hide the lifecycle bug and affect unrelated turns or transcript shape.

## Lifecycle

### Start or continue a chain

On every `agent_start`:

- mark the chain active;
- acquire the attention hold only when starting a new chain;
- capture a fresh path and timestamp baseline for the upcoming agent run.

Refreshing the baseline on follow-up `agent_start` matters. If the agent receives a failed check and makes no file changes, the same pre-existing failure must not be queued forever. If it edits a matching file, the next `agent_end` should rerun the command.

### Check before settlement

On `agent_end`:

- skip checks when the run contains an aborted assistant response;
- scan changes since that run's baseline;
- execute each matching command and preserve current timeout, output-tail, notification, and cancellation behavior;
- keep passes out of model context;
- queue the existing rendered failure message with `deliverAs: "followUp"` when any command fails.

The handler must await command execution. Returning early would let Pi settle before the failure can be queued.

### Settle the chain

Use `agent_settled` only to:

- mark the chain inactive;
- release the attention hold once;
- emit the normal ready notification disposition.

A failed check no longer needs the old `discard` disposition. The hold remains active through the queued continuation and is released after the final repaired or unchanged run settles.

Remove state that becomes redundant after the move, including the detached `run` promise and settled-time aborted-run bookkeeping. Keep the active command `AbortController` for shutdown cancellation.

## Implementation

### Extension lifecycle

- Reshape `agent_start` so each run receives a fresh change baseline while one attention hold spans the whole follow-up chain.
- Move command scanning and execution from `agent_settled` into an async `agent_end` handler.
- Catch execution errors in `agent_end`, notify once, and allow settlement.
- Change failure delivery from `{ triggerTurn: true }` to `{ deliverAs: "followUp" }`.
- Make `runChangedCommands()` return `void`; callers no longer need to distinguish a newly triggered standalone turn.
- Reduce `agent_settled` to chain and attention cleanup.
- Preserve session-shutdown cancellation and state reset.

File:

- `packages/agent/extensions/silent-command-runner/index.ts`

### Focused lifecycle tests

Add a dedicated extension test using a temporary project and a small fake `ExtensionAPI` event harness.

Cover:

1. a matching failed command is executed from `agent_end` and sends one custom message with `{ deliverAs: "followUp" }`;
2. failure delivery never uses `triggerTurn` and does not add a user message;
3. a continuation `agent_start` refreshes the file baseline, so an unchanged failed file does not cause an infinite follow-up loop;
4. a matching edit made during the repair continuation reruns the configured command at the next `agent_end`;
5. passing commands remain notification-only and send no model-visible message;
6. aborted runs skip checks;
7. the attention hold spans failure and repair, then releases once at final `agent_settled`;
8. session shutdown aborts an active command.

File:

- new `packages/agent/test/extensions/silent-command-runner/index.test.ts`

## Documentation

The extension's public behavior and settings do not change: matching checks still run automatically, passes remain quiet, and failures still appear in chat and start agent repair. Do not change Tau help, settings, schema, or the extension README for this lifecycle-only fix.

## Acceptance criteria

- Silent commands execute before `agent_settled` while Pi still reports an active run.
- A failure is queued as a custom follow-up from `agent_end`.
- The repair response, its tool calls, and all tool continuations stay in one prompt chain.
- Provider `instructions` remain stable across a repair `patch` call when model and active tools are unchanged.
- The failure-repair flow produces one settled run and one run summary.
- A no-edit repair response cannot loop on the same pre-repair file timestamps.
- Edits made by the repair response trigger the configured checks again.
- Existing matching, exclusions, command ordering, output truncation, timeouts, notifications, rendering, and shutdown cancellation remain unchanged.
- Focused extension tests and the repository's automatic TypeScript checks pass.

Interactive validation requires `/reload` before reproducing a silent-command failure.

## Out of scope

- Patching Pi's `AgentSession` lifecycle.
- Rewriting outgoing provider payloads.
- Adding cache-control settings or commands.
- Changing automatic-command configuration or matching semantics.
- Changing failure message content or rendering.
- Changing run-summary accounting outside the natural removal of the second settled run.
