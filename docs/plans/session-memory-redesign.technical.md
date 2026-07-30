# Session memory redesign: technical plan

Status: implemented.

Design authority: [`session-memory-redesign.md`](./session-memory-redesign.md).

## Outcome

Create `session-memory` as a greenfield extension with a bounded, explicit session-state machine. Do not rename, move, import, or incrementally refactor files from `working-memory`.

The new extension will:

- Store goal, objective, tasks, memories, and file tiers as one canonical snapshot.
- Append ordinary updates without rewriting earlier model input.
- Replace old context with one canonical snapshot only at checkpoints.
- Force a checkpoint before the configured context ceiling.
- Keep every tool definition and prompt guideline stable while a checkpoint is required.
- Persist state in `session_memory` tool-result details so branches replay correctly.
- Render the approved persistent widget from the same state used by context projection.

Reuse only generic shared Tau services such as autoread, outline injection, bounded results, row state, settings, events, and shared TUI. New state, projection, gating, rendering, tests, settings, and docs start in `packages/agent/extensions/session-memory/`.

Old `working-memory` remains untouched while new extension is built. Final cutover adds loaded `session-memory/index.ts` and deletes old extension in same coherent change so both never register tools, `/prune`, or context hooks together.

## Fixed decisions

### Tool actions

`session_memory` becomes a discriminated union with two actions:

```ts
type SessionMemoryInput =
 | {
   action: "update";
   goal: string;
   objective: string;
   tasks: string[];
   carry: MemoryItem[];
   durable: MemoryItem[];
   readFiles: string[];
   outlineFiles: string[];
   deferFiles: DeferredFile[];
   }
 | { action: "checkpoint" };
```

`update` always supplies a full replacement snapshot. There are no patch operations, item IDs, completion flags, or optional state fields. First task is active task; completed tasks are omitted.

`checkpoint` contains no state. It checkpoints latest successful update. A voluntary checkpoint fails unless an `update` has succeeded since previous checkpoint, and it must be the only tool call in its assistant message. This makes review explicit, prevents sibling results from being projected away, and keeps checkpoint calls small.

When required gate is active, only `action: "update"` succeeds. Successful update is committed as checkpoint in same tool call. `action: "checkpoint"` is rejected so stale state cannot satisfy required final review.

Every memory has an agent-chosen stable ID:

```ts
interface MemoryItem {
 id: string;
 text: string;
}
```

IDs are lowercase kebab-case, 1–64 characters, and unique across carry and durable memory. Existing memory keeps its ID when text changes or lifetime changes. Omit item with that ID to delete memory; keep ID and replace text to edit it; move same item from carry to durable to promote it. New memories use new IDs.

Do not add a separate read action. Current state is already model-visible:

- Every successful update returns full normalized state as tool result.
- At checkpoint, full canonical state with memory IDs is written into tool result that becomes stable projection.
- After emergency compaction removes checkpoint anchor, context hook restores canonical state as it stood at compaction. Later updates remain appended after that stable recovery projection.

A read action would append a duplicate snapshot without exposing information the model lacks.

Tool guidance states that latest successful `session_memory` call is authoritative. Checkpoint projection is baseline; any later update call in same span supersedes it until next checkpoint.

### Tool result

Every successful `update` and `checkpoint` returns full current state, like resource returned by write API. Result is one deterministic terse block:

```text
Session memory · checkpoint 4

Goal
...

Objective
...

Tasks
- ...

Carry
- cache-prefix-stability: ...

Durable
- goal-approval: ...

Files
Read
- ...
Outline
- ...
Deferred
- ... · when ...
```

Empty groups stay present with count zero so shape does not vary. Result contains no clock time, active token count, generated prose, or transient gate status. Tool arguments describe requested write; result is authoritative normalized value after deduplication, precedence, carry aging, and outline failures.

This duplicates full snapshot once per update. It remains append-only and bounded to 16,000 bytes. Clear current state is worth that cost; checkpoint gate limits accumulated copies.

### Bounds

TypeBox schemas enforce field limits and `additionalProperties: false` at every object boundary:

- Goal: 2,000 characters.
- Objective: 1,000 characters.
- Tasks: 8 items, 400 characters each.
- Carry memories: 12 items, 1,000 characters each.
- Durable memories: 24 items, 1,000 characters each.
- Memory IDs: 64 characters, lowercase kebab-case.
- Read files: 12 paths.
- Outline files: 12 paths.
- Deferred files: 8 entries.
- Paths: 500 characters.
- Deferred reason and reconsideration condition: 300 characters each.
- Normalized public snapshot: 16,000 UTF-8 bytes total.

The byte limit is checked after trimming, deduplication, path normalization, and file-tier precedence. Tool output is inherently bounded by this schema and can bypass shared text-result truncation.

### Token gates

Defaults:

- Memory reminder: 50,000 active tokens.
- Checkpoint warning: 100,000 active tokens.
- Context ceiling: 150,000 active tokens.
- Required-checkpoint reserve: 30,000 tokens.

Only context ceiling remains configurable. `settings.ts` will contain:

```ts
{
 enabled: true,
 contextCeilingTokens: 150_000,
}
```

Effective ceiling is `min(contextCeilingTokens, modelContextWindow)` when Pi reports a model context window. Required threshold is effective ceiling minus 30,000. Advisory thresholds at or above required threshold are skipped. This yields:

- 150k or larger model: reminders at 50k and 100k, required at 120k.
- 128k model: reminder at 50k, required at 98k.
- 64k model: required at 34k.

Unknown model context uses configured 150k ceiling. Missing or non-finite active token usage does not change gate state; Pi compaction remains fallback.

Reminder text becomes fixed code. `nudgeEveryTokens` and `nudgeInstructions` are removed.

### Goal ownership

First successful update initializes goal without a prompt. Later normalized goal changes require `ctx.ui.confirm`.

- Interactive approval: commit new goal.
- Rejection: fail tool call without changing state or file injections.
- No UI: fail closed with deterministic error asking agent to keep current goal and ask user first.

Whitespace-only changes do not prompt. Goal comparison happens before side effects.

### Carry lifetime

Stored carry entries include internal birth checkpoint:

```ts
interface CarryMemory {
 id: string;
 text: string;
 bornAtCheckpoint: number;
}
```

At checkpoint `N + 1`:

- Carry created during span `N` survives with original birth checkpoint.
- Carry born before span `N` survives only when same ID appears in durable memory.
- Expired carry is dropped and reported in tool warnings.
- New carry supplied by required update starts at checkpoint `N + 1`.
- Durable memory is a full replacement set and has no age.

ID is memory identity. Editing text does not reset carry age. Reusing deleted ID later creates new memory at current checkpoint age.

## Persisted state

Every successful tool call stores strict V1 details:

```ts
interface SessionMemoryDetailsV1 {
 v: 1;
 toolCallId: string;
 kind: "update" | "checkpoint";
 checkpoint: number;
 state: {
  goal: string;
  objective: string;
  tasks: string[];
  carry: CarryMemory[];
  durable: MemoryItem[];
  readFiles: string[];
  outlineFiles: string[];
  deferFiles: DeferredFile[];
 };
 outlinedRows: Array<{ path: string; rowId: string }>;
 prunedRowIds: string[];
 warnings: string[];
}
```

`toolCallId` must match enclosing tool result. Canonical state text is formatted once and persisted as tool result content. Parsing uses a TypeBox details schema plus semantic checks for memory ID uniqueness, file-tier separation, checkpoint numbers, carry ages, result-content match, and total bytes.

Branch replay scans valid `session_memory` results and returns:

- Latest canonical state.
- Latest canonical result text.
- Latest checkpoint result and anchor tool-call ID.
- Stable recovery text from the latest compaction boundary.
- Whether an update has succeeded since latest checkpoint.
- Cumulative pruned row IDs.
- Timestamp of latest valid result for widget.

Latest valid result on selected branch wins. No custom session entries mirror canonical state.

There is no legacy parser or state migration. `session_memory` starts at V1 and ignores old `working_memory` calls because tool name differs. First update initializes state; first checkpoint establishes projection.

## State transition

Tool execution follows one transaction:

1. Assert abort signal and lifecycle generation.
2. Replay latest V1 state from current branch.
3. Validate action against gate and checkpoint preconditions.
4. Normalize full update input when action is `update`.
5. Check goal approval before file work.
6. Apply carry aging and total-byte bound.
7. Resolve file-tier precedence: read, then outline, then deferred.
8. Prepare outline injections.
9. Assert lifecycle again.
10. Emit autoread request and prepared outlines.
11. Return canonical details and bounded result text.

No state is committed until tool result succeeds. Pi persists details with result, so cancellation, rejected goal changes, invalid snapshots, and outline lifecycle failures leave previous state active.

Every successful action returns deterministic canonical state text. Collapsed TUI rendering reads details for counts; expanded rendering shows same canonical result.

## File working set

Keep current file normalization and root `AGENTS.md` exclusion.

Ordinary update:

- Inject only paths newly entering read or outline tier.
- Do not reread unchanged paths.
- Leave prior raw file output in current span; update does not prune context.

Voluntary checkpoint:

- Re-inject every active read and outline path after checkpoint anchor.
- Use latest stored state without another snapshot payload.

Required update/checkpoint:

- Prepare and inject entire incoming read and outline set because earlier injections will be pruned.

Read tier wins over outline and deferred. Outline wins over deferred. Duplicate paths preserve first normalized occurrence. Failed outlines are omitted from active outline state and produce bounded warnings.

## Context projection

`context` hook projects only when branch has a V1 checkpoint.

Projection algorithm:

1. Find assistant message containing checkpoint tool call.
2. Replace that assistant message with same envelope containing only checkpoint call and sanitized arguments `{ action: "checkpoint" }`.
3. Keep matching `session_memory` result containing canonical state text.
4. Drop earlier messages and sibling calls/results from checkpoint tool batch.
5. Keep outline/autoread injections and every message after checkpoint batch.
6. Leave ambient Tau context projections in their normal extension order.

If anchor is absent because Pi compaction removed it from active messages, insert canonical state as it stood at that compaction boundary as one deterministic custom context message after compaction summary. Ordinary updates after compaction remain at the tail and never rewrite recovery text. If the latest checkpoint happened after the latest compaction but its anchor is unexpectedly absent, use that checkpoint's persisted result text.

Projection contains no timestamps, generated IDs, ref catalogs, message previews, or reconstructed user messages. Same persisted checkpoint produces byte-identical projected content.

Pruned tool and injected-file row IDs are collected before checkpoint anchor and published through existing `tau:tool-row-state.snapshot` event. Transcript remains saved; only model projection and row presentation change.

## Required gate lifecycle

Runtime gate has three states:

```text
open
required
awaiting-projection(checkpointToolCallId)
```

### Enter

`before_agent_start` and `tool_call` both recompute gate from `ctx.getContextUsage()`. Checking in `tool_call` closes gap where current assistant message crosses threshold before next turn.

Entering `required` injects one hidden deterministic instruction:

```text
Checkpoint required. Reconcile session memory with action update before using other tools.
```

If agent returns text or a failing tool call, same instruction is delivered on next model turn.

### Block

`tool_call` returns `{ block: true, reason }` for every tool except `session_memory` while state is `required` or `awaiting-projection`.

Tool definitions, active-tool list, descriptions, schemas, and prompt guidelines do not change. Pi preflights sibling calls sequentially, so non-memory siblings in checkpointing assistant message are blocked before parallel execution begins.

### Complete

Successful `action: "update"` while required:

1. Commits result as `kind: "checkpoint"`.
2. Increments checkpoint number.
3. Sets gate to `awaiting-projection(toolCallId)`.
4. Leaves every non-memory tool blocked.

`context` clears gate only after it finds that tool call and returns new projection. Failed execution or missing anchor leaves gate active.

`session_start`, `session_tree`, and `session_compact` replay branch state, refresh token usage, update widget, and discard stale in-memory gate IDs. `session_shutdown` clears widget, row snapshot, and runtime state.

Advisory reminder deduplication remains process-local per branch/checkpoint. Reload or branch selection may repeat one advisory reminder. Required gate is recomputed and cannot be skipped.

## Cache contract

Cache stability means prefix stability. Between checkpoints, each final provider payload must equal previous payload through every previously serialized field, with new conversation content appended only at tail. Whole payload cannot stay identical because agent run keeps adding user, assistant, and tool messages.

Final serialized request fields that can change:

- Ordinary update appends assistant tool call, full canonical state result, and newly requested file injections.
- Reminder appends one hidden message.
- Checkpoint replaces old message prefix with canonical checkpoint call/result pair.
- Checkpoint file injections append after canonical pair.

Stable fields:

- System prompt.
- Tool list, order, descriptions, schemas, and guidelines.
- Existing checkpoint projection before next checkpoint.
- Existing post-checkpoint messages before newly appended update.

Checkpoint projection is persisted bytes, not a fresh serialization of `details.state`. Tool execution formats canonical state once as tool result content. Every later `context` event reuses that content and original checkpoint tool-call ID. New checkpoint gets one new tool-call ID; that ID remains unchanged until following checkpoint.

The `context` hook is pure over persisted session messages. It cannot read files, inspect clock, include current token usage, generate IDs, or render latest ordinary update into checkpoint prefix. Active token count and relative update time remain widget-only.

Autoreads and outlines are prepared once, appended as persistent session messages, and reused verbatim. Context projection never refreshes them. Changed source reaches model through an explicit later read/update or one checkpoint re-injection, always at tail of current stable prefix.

Advisory and required instructions are persistent custom messages. Repeated instructions append; they never replace an earlier instruction or modify system prompt.

### Stability by phase

1. **Before first checkpoint:** prompts, responses, tool calls, updates, reminders, and new file injections append normally. Session memory does not transform existing messages.
2. **Ordinary update:** requested snapshot appears in new assistant tool-call arguments. Full normalized state result and any newly requested files follow it. Every earlier byte remains in same order.
3. **Required gate:** tool list stays identical. Blocked calls return new tail results. Gate state and widget state never enter provider payload except persistent steering message.
4. **Checkpoint:** projection drops old conversation once. System prompt and serialized tool definitions remain reusable prefix; cache miss begins at first projected conversation message.
5. **First post-checkpoint request:** canonical checkpoint pair and re-injected files are new suffix. They become stable persisted prefix for rest of span.
6. **Later requests:** same canonical pair, same IDs, same file snapshots, and same later messages are reused byte for byte; only new tail content misses cache.

Branch switches, explicit model/tool configuration changes, extension reload, and emergency Pi compaction can change request prefix independently. Session memory must not introduce any additional invalidation.

### Forbidden cache-unstable implementations

- Rebuilding checkpoint text from live state on every `context` event.
- Projecting latest ordinary update into earlier checkpoint position.
- Adding goal, objective, gate status, or token counts to system prompt.
- Hiding or reordering tools while gate is active.
- Regenerating checkpoint tool-call IDs, file row IDs, timestamps, or relative-time labels.
- Refreshing read or outline content during `context`.
- Inserting ephemeral messages that disappear while later messages remain.

Regression tests must capture payload from `before_provider_request` after all context hooks and provider transformations. Tests compare serialized prefix fingerprints across:

1. Initial checkpoint request.
2. Consecutive ordinary updates.
3. Required-gate instruction.
4. Required update/checkpoint.
5. First request after projection.
6. Next append-only request.

Unchanged content must retain identical fingerprints. Checkpoint invalidation must begin at checkpoint projection and nowhere earlier. Tool payload must remain identical while gate is open, required, and awaiting projection.

Run payload tests through offline Anthropic, OpenAI, and Google serializer fixtures supported by installed Pi version. Compare provider-native system/tool/message fields rather than intermediate `ContextMessage[]`. A regression in any supported payload shape blocks release.

## Widget

Add production `widget.ts` under session-memory extension. It accepts immutable view state and selected tab, then composes shared `ToolPanel` and `Tabs`.

View state contains:

- Goal.
- Objective.
- Checkpoint number.
- Active token count.
- Latest state timestamp.
- Tasks.
- Carry and durable memories.
- Read, outline, and deferred files.

Rendering matches approved prototype:

- Goal and objective stay in header.
- First task is emphasized.
- Tab counts come from current state.
- Memory and file groups retain labels.
- Deferred rows include reconsideration condition.
- Memory IDs stay out of widget rows; they are model-facing mutation handles.
- Copy contains state and controls only.
- Every line wraps or truncates to width.

Widget is above editor and never handles arrows, Tab, or editor input. `/session-memory` cycles tasks, memories, files, and hidden state. Component API exposes `selectedTab` and visibility without giving the widget input ownership.

Tool Preview will import production widget, render it three times with fixture state and selected tabs, move fixture adapter to `.pi/extensions/tool-preview/widgets/session-memory.ts`, and delete old working-memory preview stories.

## File changes

### Add greenfield extension

- `packages/agent/extensions/session-memory/index.ts`
  - Registration, lifecycle wiring, gate state, branch sync, `/prune`, widget ownership.
- `packages/agent/extensions/session-memory/state.ts`
  - Input/details schemas, normalization, transition reducer, strict parser, branch replay.
- `packages/agent/extensions/session-memory/tool.ts`
  - Transactional update/checkpoint execution and file injection preparation.
- `packages/agent/extensions/session-memory/projection.ts`
  - Checkpoint projection and pruned-row collection only.
- `packages/agent/extensions/session-memory/render.ts`
  - Compact update/checkpoint rows from V1 details.
- `packages/agent/extensions/session-memory/settings.ts`
  - `enabled` and `contextCeilingTokens`.
- `packages/agent/extensions/session-memory/README.md`
  - New state model, two actions, gates, `/prune`, and widget.
- `packages/agent/extensions/session-memory/widget.ts`
  - Production `ToolPanel`/`Tabs` widget.
- `packages/agent/test/extensions/session-memory/*.test.ts`
  - New state, tool, projection, gate, rendering, widget, settings, and final-payload coverage.

### Cut over and delete old feature

- Delete `packages/agent/extensions/working-memory/` in full.
- Delete `packages/agent/test/extensions/working-memory/` in full.
- Delete `.pi/contexts/extensions/working-memory.toml`.
- Delete `.pi/extensions/tool-preview/widgets/working-memory.ts` and old working-memory session fixture after production session-memory fixture is wired.
- Remove every `working_memory`, `extensions.workingMemory`, working-memory help, preview, and schema reference.

No compatibility alias, settings translation, V2 parser, state importer, or dual-run period.

### Update integrations

- `.pi/extensions/tool-preview/widgets/session-memory.ts`
  - Fixture adapter around production widget only.
- `packages/agent/extensions/tau-help/help.md`
  - Basic usage and required-gate behavior.
- `.pi/contexts/extensions/session-memory.toml`
  - New source/test ownership.
- `.pi/contexts/extensions/tool-preview.toml`
  - Keep preview fixture as reference after duplicate renderer is removed.
- Generated Tau schema through schema sync. Do not edit `packages/agent/schemas/tau.schema.json` manually.

## Implementation slices

### 1. Canonical state

- Create V1 input and details schemas without importing old extension types.
- Add normalization, byte bound, carry aging, goal-change decision, and branch replay.
- Add new state tests for strict parse, branch replay, full replacement, carry expiry/promotion, and size limits.

Stage new files only when each slice is reachable through tests. If `index.ts` must land last to prevent dual registration, use local Fallow suppression with reason and remove it during cutover.

### 2. Tool transaction

- Implement update, voluntary checkpoint, and required update/checkpoint.
- Diff ordinary file injections and re-inject complete checkpoint working set.
- Keep lifecycle cancellation and root-instruction exclusion.
- Test rejected checkpoints, denied goal changes, no-UI behavior, precedence, outline failure, and side-effect ordering.

### 3. Projection

- Implement projection without reference-catalog concepts.
- Project compact checkpoint pair and preserve post-checkpoint messages.
- Keep visual pruned rows.
- Test sibling blocked calls, ambient projections, missing anchors, branches, and deterministic output.

### 4. Gates and lifecycle

- Implement fixed gate calculation from scratch.
- Add `tool_call` blocking and awaiting-projection state.
- Keep tool registration stable.
- Update `/prune` instruction to request update followed by voluntary checkpoint.
- Test threshold order, smaller model windows, repeated refusals, tool failure, sibling calls, projection clearance, branch switch, compaction, and shutdown.

### 5. Cache regression

- Add final-payload harness using `before_provider_request`.
- Assert stable prefix and tool fingerprints across consecutive requests.
- Assert checkpoint changes only intended message boundary.
- Assert current file contents appear after checkpoint projection without moving mutable content ahead of stable state.

### 6. Production widget

- Use `/session-memory` as the non-editor-stealing tab/toggle binding.
- Build production component with shared `ToolPanel` and `Tabs`.
- Wire branch replay, token updates, state updates, and cleanup.
- Add narrow-width, empty-section, selected-tab, and state-refresh render tests.
- Replace Tool Preview duplicate with fixture adapter.

### 7. Docs and cleanup

- Update extension README and Tau help.
- Regenerate Tau settings schema after `settings.ts` change.
- Add session-memory context entry through context sync after source and tests are wired.
- Delete old extension, tests, context entry, preview stories, settings, help, and generated schema references in same cutover.
- Reload extensions before interactive testing.

## Acceptance checks

- Agent can initialize and replace complete state with `action: "update"`.
- Every successful update returns one full authoritative normalized state block.
- Agent always sees current memory IDs through latest update, checkpoint projection, or compaction recovery projection.
- Goal cannot change silently.
- Carry memory survives one checkpoint and then promotes or expires.
- Voluntary checkpoint requires prior update in current span.
- Required gate blocks every non-memory tool and cannot clear before projection.
- Sibling tool calls remain blocked during required checkpoint turn.
- Context after checkpoint contains one canonical state pair, active file injections, and later messages.
- Saved transcript and branch history remain intact.
- Ordinary updates preserve longest serialized provider prefix.
- Tool definitions remain byte-identical across gate states.
- Widget and Tool Preview use same production renderer.
- No working-memory extension, tool, settings, tests, context entry, preview story, or schema surface remains.
- TypeScript, unit, formatting, lint, dead-code, schema-drift, and Markdown checks pass.

After implementation, ask whether to delete both persisted plan artifacts:

- `docs/plans/session-memory-redesign.md`
- `docs/plans/session-memory-redesign.technical.md`
