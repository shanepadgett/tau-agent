# Conversation Management Working Notes

Status: rough alignment. Not implementation plan yet.

Use this file for the conversation. Human can add bracket comments anywhere:

- `[human: ...]` for notes or objections.
- `[question: ...]` for things Rok should answer.
- `[decision: ...]` when something should move to Settled.

Rok will promote stable bits into Settled and leave uncertain bits below.

## Settled So Far

- We want a cohesive system for long conversations, not three separate clever tricks.
- Compaction should preserve continuation: what to do next, what constraints matter, and how to recover exact detail.
- Search working memory already owns stale/forgotten search evidence. Conversation management should use that concept instead of inventing a parallel memory swamp.
- Goal should be explicit state, not guessed later from user messages during compaction.
- First-message goal approval should happen from the first submitted prompt. The accepted goal can be inserted after the user prompt, before the agent response.
- Goal updates are approval-based. The agent should not directly rewrite the active goal.
- There is one active goal. Prior goals are retained as history when goals change.
- Goal completion is intentionally conservative. The agent should only ask about updating/completing the goal when it is obviously clear the current goal has been met.
- Goal text should be terse operational state: a tight interpretation of the user's messy request, focused on the one thing to work on or the common thread across several asks.
- Initial approval UI should present the proposed goal and allow a keypress to approve plus another path to provide feedback/edit/regenerate.
- Follow-up goals can be proposed later by the agent, not only during initial goal creation.
- Off-track new threads should usually be parked as ideas for a new chat instead of becoming in-session follow-up goals.
- Completion/promotion flow starts in normal chat: agent asks when completion is obvious; user says yes; agent uses the goal tool.
- Goals and ideas may belong to one broader work-management concept. `/ideas` can remain as a slash command, but the agent should also be able to log ideas.
- Name the merged work-management concept `focus`.
- Merge the existing `ideas` extension into the `focus` extension boundary.
- Instant compaction summary should carry goal, relevant files/ranges, irrelevant files/ranges, files touched, and a short recent chat tail.
- Irrelevant files stay carried forward while the goal is unchanged so the agent knows not to reread them.
- Read-once guard is a hard deny for unchanged already-covered ranges, with a terse reason/evidence for the agent.
- Compaction should not proceed when there is no focus-memory checkpoint and no concrete repo/tool state to preserve.
- If compaction needs focus cleanup first, it should trigger an agent turn asking the agent to use the focus tool to mark what remains relevant/irrelevant. After that tool call, compaction happens automatically at the end of the agent turn.
- Split responsibilities: `search` owns search/read tools and evidence metadata; `focus` owns working-memory relevance and compaction policy.
- `search` owns the read coverage guard because it owns `read`.

## Reference Notes Read So Far

- DCP README: compress replaces stale ranges/messages with summaries; dedupes repeated tool calls; purges old errored tool inputs while preserving error messages. Source: `/Users/shanepadgett/.local/share/tau-agent/references/opencode-dynamic-context-pruning/README.md:31-52`.
- pi-mrc README: compact into minimum viable summary plus KEEP chunks; stash recoverable detail behind exact handles; inject dynamic refs late before current user prompt. Source: `/Users/shanepadgett/.local/share/tau-agent/references/pi-model-reference-compactor/README.md:9-17`, `:82-143`.
- pi-mrc README: source refs should be locators, not stale copied code; exact unrecoverable facts stay in prompt or lookup. Source: `/Users/shanepadgett/.local/share/tau-agent/references/pi-model-reference-compactor/README.md:145-164`, `:286-296`.
- pi-vcc README: deterministic algorithmic compaction, brief transcript, semantic sections, active-lineage recall. Useful baseline, but regex-extracted goal/context sections look brittle for our goal idea. Source: `/Users/shanepadgett/.local/share/tau-agent/references/pi-vcc/README.md:13-52`, `:86-140`, `:142-194`.
- Tau Search now owns search tools, evidence metadata, auto-read/path-update messages, freshness, and read coverage. Focus owns memory relevance. Source: `src/extensions/search/README.md:1-7`.

## Pi TUI / Extension Evidence

- `ctx.ui.custom()` supports custom interactive TUI components from extensions. Source: `/Users/shanepadgett/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/docs/tui.md:89-96`.
- Selection dialogs are a first-class pattern using `SelectList` inside `ctx.ui.custom()`. Good fit for approve/edit/regenerate if we need more than built-in `select` / `editor`. Source: `/Users/shanepadgett/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/docs/tui.md:597-656`.
- Persistent footer status exists via `ctx.ui.setStatus(...)`, but footer is too small for goal text. Source: `/Users/shanepadgett/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/docs/tui.md:733-743`.
- Persistent widgets above/below editor exist via `ctx.ui.setWidget(...)`; above editor is default. This is the likely surface for active/follow-up goal display. Source: `/Users/shanepadgett/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/docs/tui.md:777-802`.
- `plan-mode` example uses both `setStatus` and `setWidget`, persists state with `appendEntry`, and sends custom visible messages with `sendMessage`. Source: `/Users/shanepadgett/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/examples/extensions/plan-mode/index.ts:58-82`, `:113-120`, `:267-329`.
- `widget-placement` example confirms simple above-editor and below-editor widgets. Source: `/Users/shanepadgett/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/examples/extensions/widget-placement.ts:1-9`.
- `input` event can intercept raw user input before agent processing and return `{ action: "handled" }` to skip the agent. Could be used for unusual blocking flows, but probably not needed if goal appears after first user prompt. Source: `/Users/shanepadgett/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md:837-868`.
- `before_agent_start` fires after user submits the prompt and before the agent loop. It can inject a persistent custom message. This matches the revised shape: first user prompt, then approved goal message, then agent response. Source: `/Users/shanepadgett/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md:497-535`.
- Extension event handlers can be async. `before_agent_start` handlers return `Promise<BeforeAgentStartEventResult | void>` and runner exposes `emitBeforeAgentStart(...)` as a `Promise` that combines returned messages/system prompt. Source: `/Users/shanepadgett/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:828-833`, `:917-920`, `:1055-1056`; `/Users/shanepadgett/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/runner.d.ts:123-128`.
- `ctx.ui.custom()` itself returns a `Promise<T>`, so awaiting an approval UI inside an async extension handler is type-supported. Source: `/Users/shanepadgett/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:91-100`.
- `pi.sendMessage()` injects custom messages into the session; `display: true` shows them. Delivery modes include `steer`, `followUp`, and `nextTurn`. Source: `/Users/shanepadgett/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md:1339-1379`.
- `pi.appendEntry(customType, data)` persists extension state and does not participate in LLM context. Good fit for durable goal state and prior goal history. Source: `/Users/shanepadgett/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md:1390-1404`.
- Custom message renderers exist via `registerMessageRenderer(customType, renderer)` plus `sendMessage({ customType, display: true })`. Good fit for goal set/update chat rows. Source: `/Users/shanepadgett/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md:2517-2543`; example at `/Users/shanepadgett/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/examples/extensions/message-renderer.ts:15-57`.
- Focus exposes `/ideas <text>` to log rough repo ideas, `/ideas` to browse in TUI, and loading an idea puts its text into the editor. Source: `src/extensions/focus/ideas.ts`.
- Ideas storage remains `.pi/tau/ideas.jsonl` via shared record helpers. Source: `src/extensions/focus/ideas.ts`, `src/shared/jsonl-store.ts`.
- Ideas browser uses a custom `SearchList` with edit/delete actions and native `ctx.ui.editor` for editing. Source: `src/extensions/focus/ideas.ts`.

## Rok's Current Small Shape

Visible continuation state:

- active goal
- follow-up goal
- explicit focus checkpoint from the focus tool, if present
- relevant files/ranges
- irrelevant files/ranges
- files touched
- blockers and failing evidence signatures
- recent transcript tail untouched

Hidden recoverable state:

- exact tool outputs worth keeping
- exact errors, benchmark/test results, IDs, user decisions
- important reads as source locators, not copied code bodies
- deleted or dirty context not recoverable from repo files
- handles for lookup when visible state is insufficient

Active cleanup:

- stale search evidence drops from active prompt
- repeated reads/tool outputs collapse
- old errors keep signature visible, body behind handle
- source bodies become path/symbol locators

Core rule: summary tells agent what to do next. Handles let agent recover why.
Correction: compaction should not invent constraints, decisions, or next action from transcript. Those only exist if explicitly captured in focus state/checkpoint or visible recent tail.

## Instant Compaction / Focus Memory Idea

Rough candidate shape:

- Stable focus state means raw user messages do not need to be preserved as the goal source.
- Raw user messages can be culled only after durable focus state/checkpoint or recent chat tail keeps anything still needed. User messages may contain more than the goal.
- Bulk search/navigation output (`find`, `ls`, `grep`) should usually be culled from active context.
- Complete file reads are the main carry-forward evidence.
- Important reads are known by subtraction: keep complete reads unless later evidence or the focus tool marks them irrelevant/done/outdated.
- After broad exploration, the agent should use the focus tool to mark irrelevant paths/evidence and retain a short checkpoint.
- Auto-read evidence after mutations can carry forward the current file content without requiring another explicit read.
- The compactor can bring forward unforgotten complete reads and auto-reads, while stubbing or removing navigation searches.
- Read-once rule: if a file has already been completely read and has not changed since, another read of that file or any range inside it should be denied.
- Partial-read rule: if only a range has been read, a later read is allowed only for uncovered ranges, unless the file changed.
- File mutation invalidates prior read coverage for that path and replaces it with mutation evidence / auto-read if available.
- Instant compaction should keep the last two user/assistant message pairs as chat tail, but drop tool calls between them.
- When compactions stack, older compaction summaries are culled/merged too. Do not keep a pile of stale summaries.
- If the goal has not changed, carry forward irrelevant-file memory across compactions.
- If only chat happened and the focus tool has never been called, compacting immediately is low value and risky. Better to force a focus checkpoint first.
- Search tools should keep producing structured evidence metadata. Focus consumes that metadata to decide what survives compaction.

Rok lean:

- Reshape `forget` into the agent-facing `focus` tool rather than growing a second memory tool.
- Keep the operation small: mark evidence/path disposition plus retain terse checkpoint.
- Existing search pruning already has most mechanics: roles (`current`, `navigation`, `mutation`, `memory-action`), `forget` dispositions, auto-read messages, and context stubbing.
- Add a separate read-coverage guard to the read tool path. Do not make compaction guess this from text.
- Read coverage guard belongs in `search`, not `focus`, because `search` owns the `read` tool.
- Denied rereads should say why tersely and point to prior coverage, not silently stub.
- Summary shape should be sections, not prose blob: focus, relevant files/ranges, irrelevant files/ranges, files touched, constraints/decisions, next action, recent chat tail.
- Summary shape should be sections, not prose blob: focus, relevant files/ranges, irrelevant files/ranges, files touched, explicit checkpoint/next if supplied by the focus tool, recent chat tail.
- No deterministic extractor for constraints/decisions/next action. If we want them, the focus tool must write them explicitly, likely as `keep` and optional `next`.
- Relevant complete reads may stay as full content when they are still active evidence; irrelevant reads become path/range warnings, not full content.
- Manual/automatic compaction can have a preflight: if focus memory is missing, request a focus-cleanup agent turn instead of producing a weak summary.
- The cleanup turn should be narrow: no new investigation unless needed, just call the focus tool with current working-memory disposition.

## Search / Focus Boundary

`search` owns:

- `read`, `grep`, `find`, `ls` tools.
- Tool call/result rendering.
- Search evidence metadata on tool results.
- Read coverage tracking and hard-deny rereads for unchanged covered ranges.
- Mutation invalidation for read coverage, likely using the existing mutation evidence path.

`focus` owns:

- Active goal and follow-up goal.
- Parked ideas and `/ideas` command boundary after merge.
- Agent-facing focus tool, replacing `forget` as public memory management.
- Relevant/irrelevant/done disposition over search evidence.
- Explicit checkpoint/next fields supplied by the agent.
- Compaction preflight and compaction summary policy.

Boundary rule: search produces evidence; focus manages attention.
No two public memory systems. Focus owns relevance; search only produces evidence and freshness plumbing.

## Goal Management Idea

Rough candidate shape:

- Every session has one active goal, even exploration/explanation sessions.
- On a fresh session, derive a goal from the first user message with a small model completion.
- Show a small TUI for approving, editing, or giving feedback and regenerating the goal.
- Candidate negotiation stays out of normal model context until the user accepts a goal.
- Accepted goal is recorded as explicit session state and survives immediate compaction.
- Agent gets a work/goal management tool for goal updates and idea logging.
- Goal set/update appears in chat through a custom rendered message so the user can see what changed.
- Compaction reads goal state directly instead of re-extracting goal from transcript.
- A follow-up goal may exist when the user includes a clear secondary task. It can later be promoted to active goal.
- The agent may propose a follow-up goal later when new scope appears.
- If a new user thread does not belong to the current track, the agent may capture or suggest capturing it as an idea for a new chat instead of turning it into an in-session follow-up goal.
- The active goal and follow-up goal should be visible in a persistent UI area above input if Pi exposes a suitable widget/status surface. Active is highlighted; follow-up is dimmed. Prior goals are not shown there.
- Pi appears to expose the right persistent surface as `ctx.ui.setWidget(...)` above editor.

Rok lean:

- Goal is durable state plus visible chat events.
- Goal candidate text is disposable until approved.
- Compactor trusts accepted goal state.
- Agent may propose/update goal, but user-visible history should make changes obvious.
- Avoid splitting user asks into micro-goals when one common thread works.
- Completion flow should mostly happen in normal chat. If the agent thinks the goal is complete, it should end its message by asking whether to finish the goal. If the user says yes, the agent uses its goal tool.
- If a follow-up exists, finishing the active goal can promote that follow-up through the same tool flow. Start simple; adjust later if awkward.

## Public Surface Candidates Needing Approval Before Implementation

- Automatic first-message goal extraction.
- Goal approval/edit/regenerate TUI.
- Goal management tool exposed to the agent.
- `forget` reshaped/replaced as a `focus` tool for marking irrelevant/done evidence and logging ideas.
- Read-once guard that denies rereads of unchanged covered file ranges.
- Custom-rendered goal set/update chat messages.
- How accepted goal is injected into compaction / active prompt.
- Instant compaction rules for culling user messages and navigation/search evidence.

## Open Questions

- No current product-shape questions. Next questions are implementation/spike questions.

## Current UI Lean After Research

- Use `ctx.ui.setWidget("goal", ...)` for persistent active/follow-up display above editor.
- Use `registerMessageRenderer("goal-event", ...)` for visible goal set/update/completion rows in chat history.
- Use `appendEntry("goal-state", ...)` for durable state outside context.
- Prefer `before_agent_start` for initial goal approval so the original user prompt remains the first message.
- Avoid replaying the original prompt unless a spike proves `before_agent_start` cannot support the UI flow.
- Use `before_agent_start` or `context` only for compact goal context injection, not as the source of truth.
- Research says awaiting approval UI inside `before_agent_start` is type-supported and likely right. Still verify with a tiny spike because TUI behavior can be weirder than types.
- Use one focused custom approval component. It can still call/use built-in primitives/patterns internally, but the user experience needs one screen: proposed goal, optional follow-up, approve key, feedback/edit path.
- Ideas tie-in is probably not a bolt-on. There is a refactor opportunity: current `ideas` is already a small work parking lot, and goals are active work focus. Same product area.
- Keep `/ideas` as a user command, but move internals under the broader `focus` boundary when implemented.
- Focus tool likely replaces the current `forget` public tool. It should still support current `done` / `irrelevant` pruning behavior, plus focus-specific actions like update goal, finish/promote goal, and log idea if approved.
- Instant compaction should lean on explicit evidence metadata, not transcript scraping.

## Watchouts

- Avoid pi-vcc-style regex goal guessing as the source of truth.
- Avoid DCP-size config/policy sprawl at the start.
- Avoid fuzzy transcript recall as the first recovery mechanism. Exact handles first.
- Do not let copied source snippets become authoritative after files change.
- Do not drop raw user messages because an extractor guessed their requirements/decisions. Keep needed bits only through explicit focus checkpoint fields or recent chat tail.
- Do not deny rereads after file mutation; changed file means old coverage is stale.
- Do not let irrelevant-file memory vanish while the active goal is unchanged.
