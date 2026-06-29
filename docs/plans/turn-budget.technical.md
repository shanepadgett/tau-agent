# Turn Budget Technical Plan

## References

- Read `docs/plans/turn-budget.spec.md` whole before implementation.
- Read `src/extensions/soul/index.ts:19-39` for settings load on `session_start` and `context` message replacement.
- Read `src/extensions/soul/modes/runtime.ts:129-145` for `pi.sendMessage` visible markers and hidden custom context message shape.
- Read `src/extensions/silent-command-runner/index.ts:82-84` and `src/extensions/silent-command-runner/index.ts:163-170` for custom message renderer and visible custom message pattern.
- Read `src/extensions/footer/index.ts:169-199` for slash command toggle shape.
- Read `src/extensions/reference/settings.ts:5-18` for colocated Tau settings shape.
- Read `.pi/extensions/tool-preview/index.ts:11-30` and `.pi/extensions/tool-preview/index.ts:39-78` for preview registration.
- Read `.pi/extensions/tool-preview/widgets/autoread.ts:24-76` for agent payload preview and simple custom row component shape.

## Code Ladder

- Need exists: yes. User wants a new `turn-budget` extension plus visible preview work.
- Existing pattern: reuse Tau extension settings, Pi events, custom messages, custom renderers, and tool-preview widget pattern.
- Small refactor: yes. The preview work exposed the same dot + bold label + muted detail row shape in autoread and turn-budget. Extract that as a real shared TUI component now and use it from runtime turn-budget marker plus preview/autoread rows.
- Stdlib/platform: no Node APIs needed.
- Existing dependency: use `typebox`, `@earendil-works/pi-coding-agent`, and `@earendil-works/pi-tui` only where existing patterns already use them.
- One line: no. Needs state and event coordination.
- Smallest code: one extension folder, one settings file, one README, one focused shared TUI line component, plus preview/autoread callers updated to use it.

## Files

- Add `src/extensions/turn-budget/index.ts`.
- Add `src/extensions/turn-budget/settings.ts`.
- Add `src/extensions/turn-budget/README.md`.
- Add `src/shared/tui/labeled-dot-line.ts`.
- Update `src/extensions/explore/autoread.ts`; `AutoreadMessageComponent.render` already builds `dot + title + muted path` and truncates it before optionally appending expanded content.
- Update `.pi/extensions/tool-preview/widgets/autoread.ts` to use `src/shared/tui/labeled-dot-line.ts`.
- Update `.pi/extensions/tool-preview/widgets/turn-budget.ts` only if preview text/component needs alignment with final strings.
- Keep existing `.pi/extensions/tool-preview/index.ts` and `.pi/extensions/tool-preview/README.md` changes unless final preview command name changes.

## Shared TUI component

Create `src/shared/tui/labeled-dot-line.ts`.

Purpose: one-line TUI marker for lightweight custom messages and context-derived rows.

Component behavior:

- renders a leading dot
- renders a bold label
- renders one or more detail parts after the label
- truncates to available width with `truncateToWidth`
- caches rendered lines by width
- exposes `invalidate()` by clearing the cache

Inputs should be small and explicit:

- `theme`
- `dotColor`, defaulting at caller or required by constructor
- `label`
- `labelColor`
- `parts`, already colorized or with a simple color enum if that keeps callers cleaner

Do not make it know about turn budgets, autoread, pruning, tools, or custom messages. The component owns row mechanics only. Callers own semantics.

Use this component for:

- turn-budget runtime visible marker renderer
- `.pi/extensions/tool-preview/widgets/turn-budget.ts`
- `.pi/extensions/tool-preview/widgets/autoread.ts`
- `src/extensions/explore/autoread.ts` first-line rendering

For `src/extensions/explore/autoread.ts`, keep expanded content handling in `AutoreadMessageComponent.render`: render the shared dot line first, then append `theme.fg("muted", content)` when expanded and content is a string. Do not make `LabeledDotLine` own expansion or pruning semantics.

This is the right shared boundary: row rendering mechanics are shared; budget math and autoread state are not.

## Settings

Use `src/extensions/turn-budget/settings.ts` with `defineTauExtensionSettings`.

Settings:

- `enabled`: boolean, default `true`.
- `toolCallLimit`: positive integer, default `30`.
- `nudgeEveryToolCalls`: positive integer, default `5`.
- `softCapIncrement`: positive integer, default `10`.

Normalize settings in `index.ts` after load so bad or missing runtime values collapse to defaults. Keep normalization local. Do not create generic number helpers unless repeated enough to clarify.

## State

Keep extension state in `turnBudgetExtension` closure:

- normalized settings
- `toolCallCount`
- `softCap`
- pending hint, or enough fields to render one pending hint
- last hinted count or pending boundary marker
- `visibleMarkersEnabled`

Reset on `session_start`:

- load settings
- `toolCallCount = 0`
- `softCap = settings.toolCallLimit`
- clear pending hint
- clear last hinted count
- keep `visibleMarkersEnabled` session-local. Since session start begins a new session, reset it to `false` unless implementation evidence shows command state normally survives session start.

Reload settings on `agent_start` or before handling counted events if existing extension behavior needs setting changes without session restart. Prefer `session_start` only unless repo pattern says Tau settings reload during a session is expected for this kind of feature.

## Counting and hint scheduling

Use `pi.on("tool_call", ...)` to count individual tool calls while enabled.

On each counted tool call:

- increment `toolCallCount`
- if `toolCallCount >= softCap`, schedule a soft-cap hint with:
  - `used = toolCallCount`
  - `previousCap = softCap`
  - `newCap = softCap + settings.softCapIncrement`
  - then set `softCap = newCap`
- else if `toolCallCount % settings.nudgeEveryToolCalls === 0`, schedule a normal boundary hint with:
  - `used = toolCallCount`
  - `cap = softCap`
- else do nothing

If several tool calls happen before the next `context` event, keep only the latest pending hint. This gives one model nudge after a tool batch.

Do not add a helper for simple modulo or threshold checks. Inline it in the event handler unless the handler becomes hard to read.

## Hidden context

Use `pi.on("context", ...)`.

If disabled or no pending hint, return `undefined`.

If pending hint exists, append one custom message to `event.messages` and return `{ messages }`.

Message shape should match existing custom context pattern:

- `role: "custom"`
- `customType: "tau.turn-budget.context"`
- `content: formatAgentHint(pendingHint)`
- `display: false`
- `timestamp: Date.now()`

Clear pending hint after adding it so repeated `context` events do not duplicate the same nudge.

Agent hint strings:

- normal: `Turn budget: <used>/<cap> tool calls used. Batch tools when possible.`
- extended: `Turn budget: <used>/<previousCap> tool calls used. Soft cap extended to <newCap>. Batch tools when possible.`

Keep formatting functions only if they avoid duplicating the same string logic between hidden context and visible marker details. Otherwise inline.

## Visible markers

Register `/turn-count-visibility` in `index.ts`.

Command behavior:

- trim args
- if args are present, notify usage and do not toggle
- toggle `visibleMarkersEnabled`
- notify `Turn count visibility enabled` or `Turn count visibility disabled`

When a pending hint is created and visible markers are enabled, send one visible custom message with `pi.sendMessage`.

Use separate custom type from hidden context:

- `customType: "tau.turn-budget.marker"`
- `content`: short fallback text
- `display: true`
- `details`: structured marker data

Do not pass `{ triggerTurn: true }`. Marker must not create another agent turn.

Register a message renderer for `tau.turn-budget.marker`.

Renderer output:

- gray dot
- bold `Turn Budget:`
- muted `<used>/<cap>`
- muted `Soft cap extended.` only when the marker follows a cap extension

For extended markers, show `<used>/<newCap>`, not `<used>/<previousCap>`.

Keep turn-budget-specific marker details and message parsing local to `src/extensions/turn-budget/index.ts`. Use `LabeledDotLine` from `src/shared/tui/labeled-dot-line.ts` for the actual row rendering.

## Preview

The local preview widget is already registered as `/tool-preview turn-budget`.

Keep `.pi/extensions/tool-preview/widgets/turn-budget.ts` as preview-only sample wiring, but use shared `LabeledDotLine` for the visible marker row so the preview exercises the real row component.

Preview samples:

- normal boundary: agent payload and marker `Turn Budget: 10/30`
- soft cap reached: agent payload says old cap and new cap; marker `Turn Budget: 30/40 Soft cap extended.`
- soft cap exceeded: agent payload says old cap and new cap; marker `Turn Budget: 35/45 Soft cap extended.`

Keep agent payload section in preview.

## README

Add product-level `src/extensions/turn-budget/README.md`.

Include:

- what it does: soft tool-call budget hints
- why: encourage batching and fewer provider cycles
- how users invoke visibility: `/turn-count-visibility`
- settings names and defaults

No implementation details.

## Avoid

- No shared budget abstraction.
- No factory/interface for hint types.
- No persistent session storage.
- No footer/status item.
- No hard stop, blocking, shutdown, or compaction.
- No visible markers unless toggled.
- No one-off helpers around single expressions.
- No TypeScript parameter properties or other non-erasable syntax.
