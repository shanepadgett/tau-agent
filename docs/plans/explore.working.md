# Explore Working Notes

Messy alignment file. No spec truth yet.

## User-stated shape

- Build a new extension named `explore` instead of modifying `src/extensions/search/` in place.
- Start from outcomes and work backward.
- Four explore tools: `ls`, `find`, `grep`, `read`.
- Keep tool-specific code in each tool file.
- Shared code only when it is actually reused.
- Shared components specific to explore stay inside the explore extension folder.
- Shared tool-call render-state infra belongs in `src/shared` because `ls`, `find`, `grep`, `read`, `patch`, and future focus/pruning code need it.
- Pruned tool commands should render yellow.
- Preview widgets should include an explicit "Agent receives" block for the exact agent payload when the human-facing tool row differs.
- Tool rows may render a more readable human view when approved, but the agent payload must remain inspectable in the preview.
- Read expanded rows should match built-in Pi read behavior: continuation instructions like `Use offset=... to continue` remain visible, followed by the TUI truncation warning when applicable.
- Preview pages use three heading levels: page title in bold default color, sample title in accent, block title in bold default color. All headings are title case and have one blank line before their body.
- When later context pruning changes what future agent requests receive, scrollback should still show what the agent saw at that historical step. Yellow command/title rendering is the only visible pruning marker for that row.
- Every conversation UI surface needs approved states: initial render call, collapsed result, expanded result, custom messages like auto-read/path-update.
- Local playground extension is generic custom tool preview at `.pi/extensions/tool-preview/`, not explore-specific.
- Code style should follow Pi core tool style from the uncompiled reference repo.
- Do not read focus spec files yet.

## Locked rough decisions

- `explore` registers the normal tool names: `ls`, `find`, `grep`, `read`.
- Argument schemas may be a clean break where useful; no backward-compatibility promise for old `search` args.
- `read` keeps the built-in Pi surface: `path`, `offset?`, `limit?`.
- `ls` keeps a small structured surface: `paths?`, `depth?`, `limit?`, `all?`, `long?`.
- `find` keeps structured query objects: `queries[{ path?, patterns?, type?, maxDepth?, hidden?, noIgnore? }]`, `limit?`.
- `grep` should replace raw `rg` argv arrays with structured query objects and no raw `rg` escape hatch.
- `grep` structured coverage should include literal/regex patterns, paths, include/exclude globs, case mode, word matching, context, hidden/noIgnore, limit, maxPerFile, maxLineLength, and contextOnly.
- Successful collapsed rows stay command-only.
- `ls` and `find` use compressed agent payloads and readable human trees.
- `read` expanded rows should match built-in Pi read behavior, including continuation and truncation lines.
- Collapsed rows stay command-only for both success and error results.
- Do not show generic stats/metadata lines for `ls`, `find`, or `grep`; add them later only if the agent struggles without them.
- Shared render-state helper is not part of `explore`; it is shared Tau infra for custom tool rows.
- Shared render-state helper should let another owner mark a `toolCallId` with a visual state such as pruned, then all tools using the helper render that state consistently.
- Pruned/state rendering should be color-only on the command/title row, with no status word in the row.
- Patch should be able to use the same shared render-state helper.

## Outcome discussion list

1. What should exploration prove to the model?
   - Inventory, path discovery, content hits, current file contents.
   - Which outputs are evidence versus current context?

2. What should humans see in the TUI?
   - Call line shape for each tool.
   - Collapsed result shape.
   - Expanded result shape.
   - Pruned/stale/forgotten visual state, starting with yellow command rendering.

3. What should be kept out of model context?
   - Old navigation evidence after current reads.
   - Dead-end evidence after a focus/forget-style action.
   - Mutation-adjacent evidence after patch/create/delete/move.

4. What should auto-read do?
   - After mutation, inject current contents when safe/useful.
   - When skipped, show a path update with the exact reason.
   - Need approved UI for auto-read and path-update before implementation.

5. Where are the reuse boundaries?
   - Generic TUI renderer state/wrapper likely shared.
   - Explore-only evidence and pruning rules likely inside `src/extensions/explore/` until another owner exists.
   - Tool execution/render code stays near its tool unless two tools truly share it.

6. What stays compatible with old search, if anything?
   - This is new extension work, so no compatibility promise unless approved later.
   - `search` can remain while `explore` is developed.

## Current search mechanics summary

- `search/index.ts` registers `read`, `grep`, `find`, `ls`, and `forget`, listens to patch/tau-edit events, injects startup map/guidance, and prunes context on `context` events (`src/extensions/search/index.ts:25`, `:38`, `:41`, `:59`, `:70`).
- Auto-read/path-update messages are built in `memory-messages.ts`; they carry both `searchEvidence` and `searchMemory` details (`src/extensions/search/memory-messages.ts:35`, `:67`).
- Patch integration: `patch` emits `tau:file-mutation.applied` after tool results; search listens and emits auto-read/path-update messages (`src/extensions/patch/index.ts:157`, `:161`; `src/extensions/search/mutation-memory.ts:30`).
- Tau edit integration: `.pi/extensions/tau-edit` emits `tau:context.snapshot`; search turns selected files into auto-read snapshots (`.pi/extensions/tau-edit/index.ts:87`; `src/extensions/search/mutation-memory.ts:75`).
- Auto-read eligibility rejects outside-cwd, noise, excluded, missing, non-file, gitignored, and too-large files (`src/extensions/search/mutation-memory.ts:86`).
- Pruning scans outbound context, parses evidence/custom memory messages, marks older same-path evidence outdated after current reads or mutation updates, applies forget, and replaces content with `[outdated]`, `[forgotten]`, or `[irrelevant]` (`src/extensions/search/context-pruning.ts:24`, `:68`, `:94`, `:107`, `:157`).
- Render status badges come from pruning statuses keyed by tool call id (`src/extensions/search/render-state.ts`).

Adjacent mechanics easy to forget:

- Startup workspace map from `ls` is injected into the system prompt once per session.
- `forget` is only active when `extensions.search.workingMemory` is true.
- Search custom message renderers exist only for auto-read/path-update.
- Existing UI filter widgets named search are unrelated: `src/shared/tui/search-list.ts`, commit file picker, ideas/stash browsers.

## Pi reference observations

Read these first for implementation style later:

- `pi/packages/coding-agent/src/core/tools/read.ts:74`, `:164`, `:203`
- `pi/packages/coding-agent/src/core/tools/grep.ts:68`, `:88`, `:123`
- `pi/packages/coding-agent/src/core/tools/find.ts:59`, `:76`, `:109`
- `pi/packages/coding-agent/src/core/tools/ls.ts:52`, `:62`, `:95`
- `pi/packages/coding-agent/src/core/tools/render-utils.ts`

Style notes:

- Each tool owns schema, execution, call formatting, and result formatting in one file.
- Shared render helpers are small and concrete: path rendering, text extraction, invalid arg text.
- Tool renderers reuse `Text` via `context.lastComponent`.
- Execution has pluggable operations where useful, but not abstract factories.
- Truncation details are explicit and drive both model notices and TUI warnings.

## Open discussion, not decided

- Exact evidence metadata names and whether they stay search-compatible.
- Exact pruning statuses and colors beyond yellow command rendering.
- Whether auto-read/path-update belongs to explore or a later focus extension.
- Whether the shared renderer infra wraps tool definitions or is just helper functions/components.

## Pi UI playground feasibility

Repo/API facts:

- Pi exports `ToolExecutionComponent` from `@earendil-works/pi-coding-agent` (`pi/packages/coding-agent/src/index.ts`).
- `ToolExecutionComponent` composes the real tool row shell and calls the tool definition `renderCall`/`renderResult` slots (`pi/packages/coding-agent/src/modes/interactive/components/tool-execution.ts`).
- `ctx.ui.custom()` provides the needed `tui` instance for constructing `ToolExecutionComponent`.
- `pi.registerMessageRenderer()` does not provide `tui`, only message/options/theme, so it cannot directly use `ToolExecutionComponent`.
- Extensions can `sendMessage()` custom messages, but those render as custom messages, not native tool execution rows.
- Extension context exposes read-only `sessionManager`; it does not expose append assistant/toolResult messages in the current session.

Implication:

- Clean exact preview: a local command can open a `ctx.ui.custom()` preview that renders real `ToolExecutionComponent` instances with mock args/results and states.
- Not clean exact chat transcript injection: without a real agent tool call, Pi does not expose a normal extension API to append native assistant tool-call + toolResult rows into the conversation.
- Close-enough chat transcript preview is possible with custom messages, but that would not use the native tool row shell.

## 2026-06-28 outcome notes: separate tools from focus economics

New user framing:

- Auto-read should stop being fancy.
- Tau edit may still use an event, but should also include full file paths in its prompt so the agent knows what to read if no auto-read listener runs.
- Exploration tools should be plain tools with efficient payloads and good rendering.
- Focus/pruning should likely become separate enable/disable behavior so benchmarks can compare:
  - base Pi tools,
  - modified explore tools only,
  - explore tools plus focus/pruning.
- Pruning should be framed as economic, not automatic cleanup for its own sake.

Read pruning direction:

- Do not auto-read after patch by default.
- Trust what the agent actually read.
- If a later read supersedes an earlier read, mark the earlier read prune-eligible.
- Whole-file read supersedes prior reads for that file.
- Range reads only supersede prior reads when ranges materially overlap or cover the prior range.
- Separate non-overlapping range reads in one large file should both remain.
- Superseded does not necessarily mean pruned immediately; pruning waits until economically useful.

Grep pruning direction:

- Grep/find/ls evidence can become stale when referenced files or paths change.
- Stale/superseded evidence can be marked first, then pruned only when the economics make sense.

Economic pruning questions:

- Removing an old tiny read can bust provider cache for everything after that message, so pruning may cost more than it saves.
- Need estimate inputs: pruned tokens, age/location in conversation, cache TTL assumption, time since last provider request, and maybe provider cache behavior.
- Default assumption for design discussion: short cache TTL around 5 minutes unless provider metadata says otherwise.

Possible boundary after this discussion:

- `explore`: `ls`, `find`, `grep`, `read`; payload shaping; tool UI; evidence metadata if needed by callers.
- shared renderer infra: generic tool render status/color support for custom tools such as explore and patch.
- future focus extension: context pruning, intentional forget/irrelevant notes, superseding/stale/economic pruning policy.
