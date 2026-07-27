# Working Memory Replacement Plan

Status: Ready for implementation

This plan replaces `packages/agent/extensions/context-pruning/` as a new system. It does not preserve old tool payloads, checkpoint state, or internal architecture. Product decisions come from [Context Pruning Decisions](context-pruning-decisions.md). Global autoread removal and `/context` redesign remain deferred to [Autoread Removal and Context Redesign](autoread-removal-context-redesign.md).

## Goal

Give agent a selective working-memory checkpoint that supports continuous work:

- Keep exact evidence that remains useful.
- Drop evidence already known to be irrelevant, obsolete, duplicated, or tied to abandoned exploration.
- Replace complete file carry-forward with current structural outlines.
- Carry deferred paths as cheap conditional reminders without reading them.
- Carry one concise continuation note instead of requiring visible pre-tool narration.
- Remind agent to reassess working memory without forcing cleanup or encouraging prune/reread loops.

Saved session history remains append-only and unchanged. Only future provider context is projected.

## Non-goals

- Removing shared autoread or migrating `/context`, handoff, and subagents
- Preserving `context_prune` calls or V2 checkpoint details
- Migrating old checkpoints into new state
- Replacing Pi compaction
- Building durable cross-session memory
- Automatically deciding which evidence is important
- Pruning toward a percentage or minimum token saving

## Final product contract

### Tool

Agent-facing tool name: `working_memory`

Extension package is `packages/agent/extensions/working-memory/` and settings live under `extensions.workingMemory`. Old context-pruning extension is deleted wholesale; there is no cutover layer.

Tool executes sequentially and uses strict required input:

```json
{
  "continuation": "Current state, durable decisions, active constraints, unresolved matters, and next action.",
  "keep": ["m:a1b2c3d4", "t:b2c3d4e5:1"],
  "outlineFiles": ["packages/agent/extensions/working-memory/index.ts"],
  "deferFiles": [
    {
      "path": "packages/agent/extensions/working-memory/render.ts",
      "reason": "Display is not part of current decision",
      "relevantWhen": "Checkpoint behavior is settled"
    }
  ]
}
```

All four fields are required. Empty arrays are valid. `continuation` is required and bounded; it is working-state handoff, not chain-of-thought.

### Selectable memory units

Agent sees short references injected only into provider context. Tags never alter saved transcript or human chat.

- `m:<entry-id>` selects user content, assistant prose/thinking, custom context, branch/compaction summary, bash context, or injected outline.
- `t:<entry-id>:<ordinal>` selects one complete tool call/result exchange from assistant entry.
- Materialized messages inside compaction entries add stable message ordinal before tool ordinal.

Example model-only marker:

```text
[wm m:a1b2c3d4; t:a1b2c3d4:1=read; t:a1b2c3d4:2=grep]
```

Assistant prose and tool exchanges are independently selectable. Selecting several units from same assistant entry reconstructs one assistant message in original block order, followed by selected matching results in original order.

Tool exchanges are atomic. Tool reference is offered only when matching call and result are both available and names agree. This prevents orphan calls/results in provider history.

Framework control messages are not selectable:

- Working-memory calls/results and nudges
- Runtime Context ambient data
- Legacy autoread entries
- Old `context_prune` calls/results

Legacy autoread content is never retained. Agent can request corresponding path through `outlineFiles` when structure remains useful.

### Checkpoint result

Model-visible tool result is compact Markdown:

```text
## Continue

Current state, durable decisions, active constraints, unresolved matters, and next action.

## Deferred files

- `path` — reason. Reconsider when: condition.

## Warnings

- `bad-ref` was not available and was not retained.
```

Rules:

- Continuation appears exactly once in future context.
- Successful retained selections are not repeated.
- Successful outlines are not listed because outline messages are injected separately.
- Empty deferred and warning sections are omitted.
- Invalid selectors and outline failures warn but do not cancel checkpoint.
- Cancellation or lifecycle invalidation aborts checkpoint instead of applying partial state.
- Shared bounded-text result handling keeps Markdown within model-visible limits and stores complete successful overflow in session-scoped temporary output.

### Outline injections

Every `outlineFiles` path is read at call time through Explore using ordinary non-recursive file outline defaults:

- `includePrivate: false`
- `includeDocs: false`
- no name filter

Only supported files are accepted. Directories, missing paths, unsupported languages, and parse failures produce warnings. There is no complete-read fallback for small or unsupported files.

Each success becomes separate `tau.explore.outline` custom message after checkpoint. Agent receives path plus bounded outline body. Human sees compact `Outline: <path>` row and can expand it. Outline row can later show pruned visual state.

If same normalized path appears in `outlineFiles` and `deferFiles`, outline wins. Duplicate paths collapse by resolved absolute path while preserving first request order.

### Future model context

After applied checkpoint, provider receives:

1. Latest ambient Runtime Context through system prompt
2. Explicitly retained memory units in original chronology
3. Sanitized `working_memory` anchor call with continuation removed from historical arguments
4. Canonical Markdown result containing continuation, deferred guidance, and warnings
5. Separate successful outline injections
6. Every message created after checkpoint

Everything else before anchor is absent.

### Human display

Collapsed tool row:

```text
working_memory · 2 kept · 1 outline · 1 deferred
Checkpoint · kept 2 · outlined 1 · deferred 1 · removed 31
```

Expanded result shows bounded:

- Continuation note
- Retained reference labels and short previews
- Outlined paths
- Deferred paths and conditions
- Warnings

It does not show internal persisted payloads or duplicate outline bodies. Existing tool and injected-outline rows removed by checkpoints remain warning-colored where row IDs exist.

## Guidance contract

Tool description and prompt guidance teach one model:

- Working-memory boundary is reassessment opportunity, not pruning command.
- Continue active exploration when current evidence is still useful.
- Remove known dead ends, obsolete outputs, duplicate evidence, and bulky irrelevant reads.
- Keep exact evidence when it remains active or expensive to reacquire.
- Use outline when only structure/navigation remains useful.
- Defer path when relevance is conditional and contents are not needed now.
- Carry nothing when evidence has no expected value.
- Never prune useful evidence merely to reread it.
- Continuation captures conclusions and next action without duplicating retained evidence.

No tier says agent must prune before further tool work.

## Nudge behavior

### Settings

Keep settings surface small:

```json
{
  "extensions": {
    "workingMemory": {
      "enabled": true,
      "nudgeEveryTokens": 40000,
      "nudgeInstructions": [
        "Reassess working memory. Continue coherent exploration when its evidence remains useful; otherwise prune known dead ends, obsolete outputs, and other context with no expected value.",
        "Context is materially larger. Prune stale or bulky irrelevant evidence when safe, but keep active working evidence that would otherwise need to be reread.",
        "Strongly reassess before more broad work. Remove accumulated waste and carry useful information at cheapest sufficient fidelity without scrubbing the active working set."
      ]
    }
  }
}
```

Later 40k boundaries repeat final instruction. Instructions remain one through five bounded nonempty strings.

### Visible boundary nudge

After tool-using turns, emit one visible marker when active context crosses next unsent 40k boundary. Marker content is model-visible, advisory, and rendered compactly for human.

After checkpoint, first post-checkpoint usage establishes suppression floor. Already-crossed boundaries do not immediately produce visible repeats; next higher boundary does. Branch navigation and compaction reconstruct emitted boundary state from active branch.

Remove current tier-floor and terminal-tier enforcement. Tier comes only from current boundary number and configured instruction count.

### Hidden agent-start nudge

On every `before_agent_start`:

- Read active context usage.
- If below first boundary, do nothing.
- Otherwise choose highest applicable instruction, capped at final tier.
- Append it to system prompt for that agent run.

Do not inspect prompt source or persist a hidden custom message. Per-run system-prompt injection avoids duplicate session entries and makes extension/steer/follow-up distinctions unnecessary.

### Manual command

Keep `/prune` with no arguments. It sends visible manual working-memory request and triggers agent turn. Extra arguments show `Usage: /prune`. Command remains gated by `enabled`.

## Architecture

### 1. Context-pruning extension owns policy

`packages/agent/extensions/working-memory/` owns:

- `working_memory` schema and execution
- Memory-unit catalog and selector semantics
- Provider-context projection and model-only reference tags
- Persisted checkpoint parsing/replay
- Continuation/deferred/warning Markdown
- Nudge state and lifecycle
- Tool/nudge rendering
- Settings and product guidance

No code in this package imports autoread or complete-file knowledge.

Planned files:

```text
working-memory/
  index.ts       lifecycle, registration, nudges, /prune
  checkpoint.ts  schema, validation, execution, Markdown result
  memory.ts      catalogs, refs, materialization, annotation, projection
  state.ts       V1 details parser and branch replay
  render.ts      tool and visible nudge renderers
  settings.ts    enabled + 40k interval + tier instructions
  README.md      product behavior
```

These replace old extension wholesale. No old filenames or compatibility entrypoints remain.

### 2. Explore owns structural production

Add `packages/agent/extensions/explore/outline-injection.ts` to own:

- File outline query through existing engine
- Existing outline formatter reuse
- Shared bounded-output handling through Explore temporary store
- `tau.explore.outline` message shape
- Compact message renderer and pruned-row observation

Explore `index.ts` registers provider using same cached `engineFor`, `rowState`, and `TemporaryOutputStore` as outline tool. This avoids second parser, duplicate cache, and context-pruning knowledge of tree-sitter internals.

### 3. Shared boundary is narrow typed provider registry

Add `packages/agent/shared/outline-injection.ts` containing only cross-extension contract:

- Request type: cwd, batch/tool ID, paths, signal, lifecycle guard
- Per-path success/failure result
- Prepared custom message type
- Provider registration and lookup keyed by Pi event bus using `WeakMap`

Context-pruning requests outlines through this contract. Explore registers implementation. If no provider exists, request fails immediately with actionable warning; no event timeout or global mutable singleton.

Provider unregisters on session shutdown/reload only when registration still owns slot.

### 4. Persist selectors, not copied message bodies

Checkpoint details store stable selectors and display metadata, not duplicate retained content:

```ts
interface WorkingMemoryCheckpointDetailsV1 {
  v: 1;
  anchorToolCallId: string;
  retainedRefs: string[];
  retainedLabels: Array<{ ref: string; label: string; preview: string }>;
  prunedRowIds: string[];
  outlinedFiles: Array<{ path: string; rowId: string }>;
  deferredFiles: Array<{ path: string; reason: string; relevantWhen: string }>;
  removedUnits: number;
  warnings: string[];
}
```

Replay scans only valid `working_memory` tool results whose detail anchor matches result call ID. Latest checkpoint supplies retained refs, deferred state, and complete pruned-row snapshot.

Materialization resolves refs against append-only active branch using Pi `sessionEntryToContextMessages`. Compaction-contained messages use deterministic entry/message ordinals. No large payload duplication in tool-result details.

### 5. Projection operates on valid memory units

Before each provider request:

1. Build referenced view from `buildContextEntries()` using Pi's own entry-to-message conversion.
2. Match refs to `event.messages`; unmatched extension-produced messages remain unreferenced rather than being dropped accidentally.
3. Locate latest applied `working_memory` anchor.
4. Materialize latest retained refs from full active branch.
5. Append anchor and post-anchor messages.
6. Replace historical anchor arguments with compact placeholder while keeping call ID/name and matching result valid.
7. Inject `[wm ...]` tags into copies of selectable messages.
8. Publish accumulated pruned row-state snapshot.

No session messages are mutated. Missing anchor means projection returns original messages with reference annotations only.

### 6. Runtime Context becomes truly ambient

Change `runtime-context` to append fixed session snapshot and current date to per-run system prompt in `before_agent_start` rather than persisting hidden custom messages.

Outcomes:

- Working-memory projection cannot accidentally remove runtime date/root snapshot.
- Runtime Context stops believing a pruned saved entry is still active.
- No special ambient-message branch is needed in projection.
- Prompt content stays stable during session except local date rollover.

Update Runtime Context tests and README only as needed for this delivery change; snapshot contents remain unchanged.

### 7. Tool-row state remains presentation-only

Keep shared `tool-row-state` event surface. Working-memory state publishes complete accumulated snapshot for:

- Unretained tool-call IDs
- Old injected-outline row IDs

Do not add generic visual state for user/assistant messages. Checkpoint result counts cover those removals while transcript remains saved and readable.

## Failure and lifecycle behavior

- Unknown/expired `keep` ref: warning; ref is not retained.
- Duplicate ref/path: collapse without warning.
- Incomplete tool exchange: reference is not offered; forged selector warns.
- Unsupported/missing outline: warning; no full-read fallback.
- Explore unavailable: one warning per requested path; checkpoint still applies.
- Deferred path also outlined successfully: omit deferred copy.
- Malformed persisted details: ignore checkpoint entirely.
- Missing anchor in provider context: fail open by leaving context unpruned.
- Abort or session/tree/compaction generation change during preparation: throw and send no outline messages.
- Completed outline preparation followed by one failed path: send successful outline injections and include failed path warning.
- Tool result overflow: shared bounded handler preserves complete blocks and records temporary output metadata.

## Branching and compaction

- Active branch determines latest checkpoint, retained refs, nudge history, and pruned-row snapshot.
- `/tree`, compaction, new/resumed sessions, reload, and shutdown invalidate in-flight outline preparation.
- Tree/compaction replay rebuilds state from branch; no stale in-memory checkpoint authority.
- Pi compaction remains independent. If active context no longer contains checkpoint anchor, working-memory projection has nothing to filter and leaves compacted context intact.
- New working-memory checkpoints may retain compaction or branch summaries through normal message refs.
- Old `context_prune` checkpoints are ordinary historical messages and never activate new projection.

## Settings and generated schema

Write `settings.ts` with 40,000 default and advisory instructions under `workingMemory`. Keep only `enabled`, `nudgeEveryTokens`, and `nudgeInstructions`.

Do not edit `packages/agent/schemas/tau.schema.json` manually. Tau schema sync regenerates it during automatic TypeScript checks after settings change.

## Repository cleanup and integration updates

Replace or remove all old names and dead state:

- Delete `packages/agent/shared/context-pruning-state.ts`.
- Delete corresponding shared-state test; new state tests live with extension.
- Replace old extension tests rather than translating V2 assumptions.
- Update cache diagnostics cache-affecting tool marker from `context_prune` to `working_memory`.
- Delete old context-pruning tool preview widget; add a new preview only when working-memory rendering needs further TUI iteration.
- Rewrite extension README.
- Update `packages/agent/extensions/tau-help/help.md` for `working_memory`, outlines, continuation, and `/prune`.
- Remove old autoread/context-prune references from replacement package and tests.
- Leave shared autoread and its remaining consumers untouched for deferred plan.

## Implementation slices

Each slice must leave wired, tested code with no dead exports.

### Slice 1: Memory catalog and checkpoint state

- Add stable memory refs, catalog construction, selector resolution, and atomic tool materialization.
- Add V1 details parser/replay.
- Add projection tests for user, assistant prose, individual parallel tool exchanges, custom messages, summaries, branch selection, malformed state, and missing anchors.
- Remove old shared V2 state and projection code/tests in same slice.

### Slice 2: Explore outline injection boundary

- Add shared typed provider registry.
- Add Explore provider, bounded preparation, renderer, lifecycle registration.
- Cover supported outline, unsupported path, missing provider, cancellation, and output bounds.
- Wire pruned row state without autoread types.

### Slice 3: `working_memory` tool

- Add strict schema and checkpoint execution.
- Resolve refs, outlines, defer precedence, warnings, row IDs, and counts.
- Build canonical bounded Markdown.
- Register tool and send prepared outline messages only after successful execution preparation.
- Cover invalid selectors, duplicates, partial outline failures, continuation/deferred formatting, abort, and lifecycle invalidation.

### Slice 4: Guidance, nudges, and command

- Replace extension wiring.
- Add advisory tool metadata.
- Add 40k visible boundary ladder with branch replay and post-checkpoint suppression baseline.
- Add hidden `before_agent_start` system-prompt nudge.
- Keep `/prune` and enabled gating.
- Cover repeating final tier, every-agent-start hidden nudge, no usage, settings changes, tree/compaction replay, and no forced language.

### Slice 5: Rendering, ambient context, docs, and cleanup

- Replace tool/nudge rendering and preview fixtures.
- Move Runtime Context delivery to per-run system prompt and update tests.
- Update cache diagnostics and help/README docs.
- Remove every stale `context_prune`, V2, complete snapshot, autoread, and old type reference from replacement scope.
- Confirm no dead files or empty directories remain.

## Test matrix

### Memory semantics

- Keep old user request exactly.
- Keep assistant prose without sibling tool calls.
- Keep one call/result from parallel batch without siblings.
- Keep assistant prose plus selected tool exchange and preserve block chronology.
- Keep injected outline message.
- Reject forged/incomplete exchange ref with warning.
- Exclude autoread and framework-control refs.
- Apply latest checkpoint only and follow active branch.

### Projection validity

- No orphan tool calls/results.
- Anchor call/result remains provider-valid.
- Continuation appears once after historical argument sanitization.
- Post-anchor messages remain.
- Missing/malformed anchor fails open.
- Compaction summary and retained-tail refs resolve deterministically.

### Outline behavior

- Current supported source becomes outline-only injection.
- File contents never appear when declaration body exists.
- Missing/unsupported/directory paths warn and never full-read.
- Duplicate and outline/defer overlap collapse correctly.
- Large outline uses shared bounded result and complete overflow store.
- Human row says Outline, never Autoread.

### Nudge behavior

- Default boundaries: 40k, 80k, 120k, 160k.
- Instructions: tiers 1, 2, 3, then 3 again.
- Visible nudge only once per crossed boundary.
- Hidden nudge on every `before_agent_start` above boundary.
- Hidden nudge has no transcript entry or renderer.
- Post-checkpoint visible baseline suppresses already-crossed boundary.
- Nudges remain advisory at final tier.

### Human rendering

- Compact counts fit normal width.
- Expanded text is bounded and wraps/truncates through Pi `Text` conventions.
- Warnings change result color.
- Pruned tool and outline rows update after branch replay.
- Malformed details render bounded warning fallback.

### Lifecycle

- Disabled feature removes tool, command behavior, projection, nudges, and row state together.
- Reload/new/resume/tree/compaction/shutdown invalidate preparation.
- Runtime Context remains present after checkpoint without selectable ref.
- Cache diagnostics recognizes `working_memory` as cache-affecting.

## Acceptance criteria

- `working_memory` is only context-pruning tool exposed to model.
- Calling it never invokes autoread or injects complete file content.
- Agent can retain model-visible conversational content and individual valid tool exchanges through short refs.
- Future context contains one continuation note, selected evidence, direct outlines, deferred guidance, warnings, and post-checkpoint work—nothing else from before checkpoint.
- 40k configurable visible boundaries and per-agent-start hidden nudges both work and stay advisory.
- Human sees compact checkpoint and outline rows without duplicate model payload.
- Branching, compaction, reload, disabled state, cancellation, and malformed persisted data fail safely.
- Old implementation files, state, tests, docs, preview data, and cache marker references are removed or replaced.
- Shared autoread continues working for untouched consumers until deferred removal plan.

## Plan artifact after implementation

After implementation is complete, ask whether to delete this plan and `docs/plans/context-pruning-decisions.md`. Keep deferred `docs/plans/autoread-removal-context-redesign.md` unless separately completed.
