# Conversation Management Technical Plan

## References for Implementer

Read these before coding:

- `docs/plans/conversation-management.spec.md` whole file.
- `src/extensions/search/index.ts` whole file.
- `src/extensions/search/read.ts` whole file.
- `src/extensions/search/read-coverage.ts` whole file.
- `src/extensions/search/evidence.ts` whole file.
- `src/extensions/search/auto-read.ts` whole file.
- `src/extensions/search/evidence-messages.ts` whole file.
- `src/extensions/focus/index.ts` whole file.
- `src/extensions/focus/tool.ts` whole file.
- `src/extensions/focus/state.ts` whole file.
- `src/extensions/focus/goals.ts` whole file.
- `src/extensions/focus/compaction.ts` whole file.
- `src/extensions/focus/ideas.ts` whole file.
- `src/shared/jsonl-store.ts` whole file.
- `/Users/shanepadgett/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md` lines 434-474 for compaction hooks.
- `/Users/shanepadgett/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md` lines 497-535 for `before_agent_start` message injection.
- `/Users/shanepadgett/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md` lines 1339-1404 for `sendMessage` and `appendEntry`.
- `/Users/shanepadgett/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md` lines 2517-2543 for custom message renderers.
- `/Users/shanepadgett/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/docs/tui.md` lines 89-96 and 777-802 for custom UI and widgets.
- `/Users/shanepadgett/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/examples/extensions/custom-compaction.ts` whole file for custom compaction return shape.
- `/Users/shanepadgett/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/examples/extensions/message-renderer.ts` whole file for rendered custom messages.
- `/Users/shanepadgett/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/examples/extensions/plan-mode/index.ts` lines 58-82, 113-120, and 267-329 for widget/state/message patterns.

## High-Level Shape

Create `src/extensions/focus/` as the owner of goal state, parked ideas, focus memory, and compaction policy.

Keep `src/extensions/search/` as the owner of search tools, evidence metadata, rendering, mutation auto-read messages, and read coverage.

Collapse public working-memory behavior into `focus`. Remove `forget` from the public search tool surface after `focus` can replace its behavior.

Keep two status concepts separate:

- Search-owned freshness: current, stale/outdated after mutation or newer auto-read, and denied by read coverage.
- Focus-owned relevance: relevant, irrelevant, or done for compaction and agent attention.

Search may render both statuses on search tool rows. Focus owns relevance decisions. Search owns freshness decisions.

Because extension changes require `/reload`, test manually only after reload.

## Data Model

Add `src/extensions/focus/state.ts`.

Use explicit versioned records in custom session entries:

- `focus-state` for active goal, follow-up goal, prior goals, checkpoint, next action.
- `focus-memory` for relevant/irrelevant/done file/range dispositions.
- `focus-event` for visible goal and memory events.

Model records with discriminated unions. No optional fields for required state. Optional only when domain is actually absent, such as missing follow-up goal.

Use normalized repo-relative paths for file/range records. Reuse `displayPath` / `resolveSearchPath` logic from search if it stays local enough; otherwise move path normalization to a focused shared module only if both search and focus need it.

Range shape:

```ts
interface LineRange {
	start: number;
	end: number;
}
```

Use no range for complete file coverage.

## Focus Extension Files

Create:

- `src/extensions/focus/index.ts`
- `src/extensions/focus/state.ts`
- `src/extensions/focus/tool.ts`
- `src/extensions/focus/ideas.ts`
- `src/extensions/focus/goals.ts`
- `src/extensions/focus/compaction.ts`
- `src/extensions/focus/README.md`

Do not create more files unless one file starts owning two unrelated concepts.
Do not create generic renderer/helper dumping grounds. A tool owns its renderer. Goal events own their renderer.

### `index.ts`

Register:

- focus tool
- `/ideas` command
- goal lifecycle handlers and widget from `goals.ts`
- `before_agent_start` handler for initial goal flow and focus prompt guidance
- `context` handler if needed for active focus injection
- `session_before_compact` handler
- `session_start` handler to rebuild in-memory state from session entries

### `state.ts`

Provide pure helpers:

- parse focus custom entries from session branch
- reduce entries into current focus state
- append new focus entries through `pi.appendEntry`
- build compaction summary sections

Keep it UI-free and tool-free.

### `tool.ts`

Register `focus` tool with actions. Use one schema with an `action` discriminator.

Actions:

- `checkpoint`: `keep`, optional `next`, relevant paths/ranges, irrelevant paths/ranges, done paths/ranges.
- `update_goal`: new active goal, optional follow-up goal.
- `finish_goal`: optional promote follow-up.
- `log_idea`: idea text.

Return terse content. Store structured details so compaction can identify the tool call as focus memory evidence.

Keep the focus tool call/result renderer in this file. The tool owns how its calls render.

Tool guidelines must name `focus` explicitly:

- Use `focus` before compaction or after broad exploration to mark relevant and irrelevant evidence.
- Use `focus` to finish or update goals only after user-visible agreement.
- Use `focus` to log off-track ideas instead of changing the active goal.

### `ideas.ts`

Move the useful parts of `src/extensions/ideas/` under focus.

Keep command name `/ideas` and user behavior:

- `/ideas <text>` logs an idea.
- `/ideas` opens the browser in TUI.
- selecting an idea loads it into the editor.

Reuse `src/shared/jsonl-store.ts`. Keep `.pi/tau/ideas.jsonl` as storage unless the user approves a migration later.

After moving, delete `src/extensions/ideas/` or leave only a tiny compatibility entry if duplicate command registration would not happen. Prefer deleting the old extension directory so package glob does not load two owners.

### `goals.ts`

Own goal lifecycle behavior:

- first-prompt goal derivation
- approval UI
- goal widget lines and widget updates
- visible goal event messages
- goal event custom message renderer

Keep goal event rendering here because future changes to goal display and goal lifecycle will be read together.

Build one focused custom approval UI for the first goal.

Behavior:

- Show proposed active goal.
- Show proposed follow-up only when present.
- Key to approve.
- Key/path to edit or provide feedback and regenerate.

Spike this first if needed: verify awaiting `ctx.ui.custom()` from `before_agent_start` does not leave awkward TUI state and returned message ordering remains user prompt → goal event → assistant.

Goal derivation can use a small model completion through installed Pi/Pi-AI APIs. Keep prompt narrow: produce terse active goal and optional follow-up only.

Render compact rows for:

- goal set
- goal update
- goal complete
- follow-up promoted
- idea logged
- checkpoint stored

Do not hardcode keybinding hints.

### `compaction.ts`

Handle `session_before_compact`.

Use `event.preparation` for the compaction return fields. Follow `custom-compaction.ts` shape:

```ts
return {
	compaction: {
		summary,
		firstKeptEntryId: event.preparation.firstKeptEntryId,
		tokensBefore: event.preparation.tokensBefore,
	},
};
```

Build summary from deterministic state:

- active goal
- follow-up goal when present
- relevant files/ranges
- irrelevant files/ranges
- files touched
- explicit checkpoint when present
- explicit next action when present
- last two user/assistant message pairs, with tool calls omitted

Merge previous compaction summaries into the new focus state only through known structured focus sections. Do not parse arbitrary old prose.

Preflight:

- If focus state has enough checkpoint/evidence, compact.
- If no checkpoint exists and no repo/tool state needs preserving, cancel compaction and trigger a narrow follow-up/steer user message asking the agent to call `focus checkpoint`.
- After a focus checkpoint is recorded during that cleanup turn, call `ctx.compact()` at agent end or tool result completion.

Guard against loops with an in-memory `pendingCompactAfterFocus` flag reset on session shutdown/start.

## Search Extension Changes

### Remove Public Memory Ownership

In `src/extensions/search/index.ts`:

- Stop registering `forget` as an active tool once focus exists.
- Remove `MEMORY_GUIDANCE` from search system prompt injection.
- Keep startup workspace map behavior if still desired.
- Keep mutation auto-read/path-update messages under search.
- Keep search render status plumbing, but split status sources: search freshness and focus relevance.

In `src/extensions/focus/compaction.ts`:

- Own outgoing context pruning from focus state and search evidence metadata.
- Stub stale search evidence only after newer current/mutation evidence proves it stale.
- Stub focus `irrelevant` and `done` full-file evidence; keep range dispositions in summaries until range-aware pruning exists.

Deleted search memory files stay deleted:

- `src/extensions/search/context-pruning.ts`
- `src/extensions/search/forget.ts`

Update `src/extensions/search/README.md` so it describes search tools and evidence metadata only.

### Read Coverage Guard

Add `src/extensions/search/read-coverage.ts`.

Responsibilities:

- Track coverage by normalized path.
- Store complete-file coverage or covered line ranges.
- Return denial when a requested range is already covered and file has not changed.
- Invalidate coverage on mutation/path update.
- Record coverage after successful `read` and auto-read.

Use file stat identity where possible: mtime plus size is enough for first pass. If current read result includes truncation, do not record complete-file coverage.

Read behavior:

- Complete file read covers whole file.
- Partial read covers requested range only.
- If complete coverage exists and file identity matches, deny any later read of that file.
- If partial coverage exists and requested range is fully covered, deny.
- If requested range overlaps partially, allow only if the request includes uncovered lines; do not mutate the requested range silently.

Integrate in `src/extensions/search/read.ts` before calling the built-in read implementation. Return a normal tool result with `isError: true` and terse text:

```text
read denied: unchanged range already read for <path>. Use existing context or focus memory.
```

Include coverage evidence in `details` for render/status and agent debugging.

Register mutation invalidation from the existing `tau:file-mutation.applied` listener in `search/index.ts` or inside mutation memory plumbing.

### Auto-Reads and Freshness

Auto-reads stay under search because they are read evidence created by file mutation.

Move the existing mutation auto-read behavior closer to the read tool boundary if it simplifies ownership, but keep the public behavior:

- After a patch mutation completes, emit path-update messages for deletes, moves, creates, and changed files when auto-read is skipped.
- After a patch mutation completes, immediately auto-read every touched or written file that is eligible.
- Do not auto-read deleted files.
- Represent moves as path updates; auto-read the destination only when the move also changed file content or policy says current destination content is needed.
- Auto-read messages should appear immediately after the patch result.
- Auto-read details should include search evidence with `kind: "auto-read"`, `role: "current"`, `complete: true`, path, and source patch tool call id.
- A successful auto-read records read coverage for that file.
- A mutation or newer auto-read marks prior read/auto-read evidence for that path stale.
- Patch tool arguments/results can be stubbed once auto-read/path-update messages provide current file evidence.

Freshness rules:

- A read is current until the same path is mutated, moved, deleted, or superseded by a newer auto-read.
- An auto-read is current until the same path is mutated, moved, deleted, or superseded by a newer auto-read.
- A mutation invalidates prior read coverage before any new auto-read records replacement coverage.
- A path move invalidates coverage for the old path and records path-update evidence for old/new paths.
- A delete invalidates coverage and records path-update evidence.

### Search / Focus Status Bridge

Search produces evidence. Focus manages attention.

- Focus should expose a small in-memory relevance status view keyed by search `toolCallId` or normalized path/range.
- Search render state should accept freshness statuses from search and relevance statuses from focus.
- If a row has both statuses, render terse combined state such as `stale, irrelevant`.
- Search must not compute relevance from transcript or focus summaries.
- Focus must not compute freshness; it consumes search evidence and mutation/auto-read metadata.

## Context / Compaction Interaction

Focus should own outgoing context pruning.

Plan:

1. Keep search evidence details attached to tool results.
2. Search records freshness from reads, auto-reads, path updates, and mutations.
3. Focus `context` handler scans messages for search evidence and focus entries.
4. Focus replaces old navigation/search outputs with stubs based on current relevance state and search freshness.
5. Focus keeps or summarizes relevant current complete reads.
6. Focus represents irrelevant reads as path/range warnings.
7. Search render state combines search freshness and focus relevance statuses for display.

Do not use transcript text extraction for goals, constraints, decisions, or next action.

## Implementation Order

1. Add focus extension skeleton, README, and state reducer.
2. Move ideas command/browser/store into focus and delete old ideas extension entry.
3. Add focus tool with checkpoint and idea logging only.
4. Move `forget` behavior into focus checkpoint dispositions and remove public `forget` registration.
5. Move/prune search working-memory guidance from search into focus prompt guidance.
6. Add goal state, visible goal events, message renderer, and widget.
7. Add initial goal derivation and approval UI behind `before_agent_start`; spike UI ordering before relying on it.
8. Add focus compaction summary and preflight behavior.
9. Add search read coverage guard and mutation invalidation.
10. Update READMEs for `focus`, `search`, and removed/merged `ideas` behavior.
11. Clean up stale imports, dead files, and obsolete settings.

## Cleanup / Deletions

Do the cutover completely. Do not leave compatibility shells, empty folders, stale settings, or duplicate public owners.

Ideas cutover:

- Move `/ideas` command, browser, and store behavior into `src/extensions/focus/ideas.ts`.
- Update imports that use `src/extensions/ideas/*`; likely `src/shared/description.ts` should import the focus-owned browser or the moved idea API.
- Delete `src/extensions/ideas/index.ts`, `browser.ts`, `store.ts`, and `README.md` after focus owns `/ideas`.
- Delete the empty `src/extensions/ideas/` directory.
- Keep `.pi/tau/ideas.jsonl` storage path unless the user separately approves migration.

Search working-memory cutover:

- Keep `src/extensions/search/forget.ts` and `src/extensions/search/context-pruning.ts` deleted after focus replaces the public behavior.
- Keep `registerForgetTool`, `setForgetActive`, `MEMORY_GUIDANCE`, and `forget` active-tool mutation out of `src/extensions/search/index.ts`.
- Keep `workingMemory` out of `src/extensions/search/settings.ts` after focus owns memory behavior.
- If search settings change schema, edit only `settings.ts`; schema regeneration is automatic.
- Update `src/extensions/search/README.md` so it describes search tools, evidence metadata, auto-read/path-update behavior, and read coverage only.

Focus addition:

- Add `src/extensions/focus/README.md` because new Tau extensions require README files.
- Document user-facing focus behavior at product level only: active goal, follow-up, `/ideas`, focus tool, compaction behavior.

Repository cleanup:

- Search for stale references to `forget`, `search.workingMemory`, and `src/extensions/ideas` after the move.
- Remove dead exports, unused imports, obsolete tests/fixtures if any appear.
- Remove empty directories created by the migration.
- Do not keep transitional wrappers unless an existing first-party consumer still needs them; update that consumer instead.

## Risks to Spike Before Final Implementation

- `before_agent_start` awaiting custom goal UI may work by type but still feel awkward in TUI.
- Injected goal event ordering must be verified as user prompt → goal event → assistant.
- Compaction preflight that cancels then triggers agent cleanup must avoid infinite compact/cleanup loops.
- Read coverage must not deny after mutation, move, delete/recreate, or external file change.
