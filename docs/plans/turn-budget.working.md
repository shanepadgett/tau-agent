# Turn Budget Working

## Rough shape

Build Tau extension `turn-budget`.

Purpose: soft pressure model to spend fewer tool-call/provider cycles and batch discovery/execution work.

Mechanism: count tool calls, not user turns.

Default settings:

- `enabled: true`
- `toolCallLimit: 30`
- `nudgeEveryToolCalls: 5`

Nudge is tiny hidden outbound context only. No visible spam. No session history spam unless Pi requires persistence. Prefer ephemeral `context` hook mutation.

Likely files:

- `src/extensions/turn-budget/index.ts`
- `src/extensions/turn-budget/settings.ts`
- `src/extensions/turn-budget/README.md`

Relevant repo/docs facts:

- Pi `context` hook can return modified outbound messages. Docs: `/Users/spadgett/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md` lines around context event.
- Pi `tool_call` fires before each tool executes and sees every individual call, including calls from a batch. Same docs, tool events section.
- Tau settings belong beside extension entrypoint: `src/extensions/<extension>/settings.ts`.
- Existing settings pattern: `src/extensions/footer/settings.ts`, `src/extensions/soul/settings.ts`.
- Existing prompt/context extension pattern: `src/extensions/soul/index.ts` uses `before_agent_start` and `context`.

## Behavior draft

- Reset count on `session_start`.
- Increment count on each `tool_call` while enabled.
- On outbound `context`, inject/update one hidden note only when tool call count is at a nudge boundary: `5, 10, 15...` or after crossing the limit.
- Message should be very short, e.g. `Turn budget: 10/30 tool calls used. Batch related reads/checks before next response; finish fully.`
- When the count reaches or exceeds the current soft cap, extend the soft cap by 10 tool calls and say so in the nudge.
- Limit nudge example: `Turn budget soft cap reached: 30/30 tool calls used. Soft cap extended to 40. Batch related reads/checks before next response; finish fully.`
- Above limit example: `Turn budget soft cap exceeded: 35/30 tool calls used. Soft cap extended to 45. Continue only necessary work; batch tools; finish fully.`
- No shutdown, no blocking, no automatic compaction.
- Count survives within current runtime only unless we decide branch persistence is needed.

Visible inspection mode:

- Register `/turn-count-visibility` with no arguments.
- Command toggles session-local visible markers for future turn-budget nudges.
- Hidden nudges still happen regardless of visible marker state.
- Do not add a persisted setting for this unless user asks.

Preview playground:

- Add `/tool-preview turn-budget`.
- Add `.pi/extensions/tool-preview/widgets/turn-budget.ts`.
- Preview should show a minimal custom-message-style hint, not a tool row.
- Include normal boundary, soft-cap reached, and soft-cap exceeded samples.

## Open decisions

- Exact reset scope: session start only, or each user prompt/agent run. User said total turns allowed after agent start earlier, then clarified tool-call pressure. Need choose before spec.
- Whether one assistant tool batch with five calls should produce one nudge after batch. Pi can count all five `tool_call` events, but the model sees it on next provider request.
- Hidden custom message shape: use a synthetic message in `context` if type-compatible, or append tiny note to last tool result if Pi message typing makes custom context awkward.

## Discarded/held

- Visible footer/status: not needed for experiment.
- Tool or command: not needed for v1.
- Hard stop/session shutdown: explicitly wrong; soft cap only.
