# manage-sessions working

## Goal

Build Tau extension `manage-sessions` for bulk session archive/delete/unarchive, plus current-session archive/delete commands.

## Repo facts

- Pi docs: extensions use `pi.registerCommand()` and `ctx.ui.custom()` for custom TUI.
- Pi docs: command context has `ctx.newSession()` and `ctx.switchSession()` for session replacement.
- Pi docs: `SessionManager.list(cwd)` lists sessions for current project; `listAll()` lists all projects.
- Pi docs: sessions live under `~/.pi/agent/sessions/`; deleting sessions is deleting `.jsonl` files; built-in delete may use `trash` when available.
- Installed Pi type `SessionInfo` has `path`, `id`, `cwd`, `name`, `parentSessionPath`, `created`, `modified`, `messageCount`, `firstMessage`, `allMessagesText`.
- Installed Pi `SessionManager.list(cwd)` sorts by `modified` descending and reads `name` from latest `session_info`; fallback display can use `firstMessage`.
- Installed Pi session picker refuses deleting the active session and implements delete as `trash` CLI first, `unlink` fallback.
- Installed Pi default session dir path is `join(agentDir, "sessions", safeCwd)`, where `safeCwd` is `--${cwd without leading slash, with path separators/colon replaced by "-"}--`.
- Pi exports `getAgentDir()`, so archive root can be `join(getAgentDir(), "session-archive")` without hardcoding `~/.pi/agent`.
- `src/shared/tui/tabbed-multi-select.ts` is a combined tabs + filter + multiselect component. Do not reuse for new shape.
- `.pi/extensions/tau-context/index.ts` currently uses `TabbedMultiSelect`; leave it alone in first pass.
- `src/shared/tui/search-list.ts` is a searchable single-select list used by ideas/stash. New multiselect should not mutate it unless simple reuse falls out.
- `src/extensions/reference/index.ts` has inline native-looking list and destructive confirmation pattern.
- `src/shared/events.ts` is where Tau custom extension event types go. No event needed yet unless active-session commands need cross-extension notification.
- `@earendil-works/pi-tui` exports `KeyId` and `Key.shift("d")` style helpers. Pi exports `keyHint`, `keyText`, and `rawKeyHint`; use those for footer hints.
- Pi extension examples directory in the installed package is empty in this checkout, but docs reference the same APIs and built-in dist components provide patterns.

## Concrete decisions

- Full-plan weight. Destructive file ops + active session replacement + new shared TUI pieces.
- Do not use existing `TabbedMultiSelect` for this feature.
- Build shared pieces instead of another combo widget:
  - `ToolPanel` owns header/body/footer shell.
  - `MultiSelectList` owns cursor, selection, optional filter, visible window, row rendering callbacks, and action dispatch.
  - `Tabs` owns tab bar and active tab state only.
- `manage-sessions` composes the pieces. No shared component knows about sessions.
- First pass does not migrate `tau-context`, `reference`, ideas, or stash. Migration only after manage-sessions proves the shape.
- Footer rule: footer shows only key hints and destructive acknowledgement/pending confirmation text.
- Header rule: default title line, optional secondary line, optional caller-provided header lines/component.
- No filter in manage-sessions UI, but `MultiSelectList` can support optional filter because other known Tau UIs need it.
- Active sessions tab: shows non-archived sessions, newest updated first.
- Archive tab: shows archived sessions, newest updated first.
- Session scope defaults to current folder, matching Pi's `/resume` default.
- Add current/all scope toggle with `s`, because Tab/Shift+Tab already switch Active/Archive tabs.
- Row text for sessions: display name and age since last update. Keep extra details out unless needed for confirmation.
- Bulk action target rule: if selection exists in current tab, action applies to selected rows; otherwise it applies to current cursor row.
- Delete/archive older rule: Shift+D / Shift+A apply to every row strictly older than the cursor row in the current tab; cursor row remains untouched.
- Archive tab also supports Shift+U to unarchive every archived row strictly older than the cursor row.
- Archive location: sibling dir `~/.pi/agent/session-archive/`.
- Archive layout: mirror Pi project folders under the sibling archive root, e.g. `session-archive/<encoded-project>/<session>.jsonl`.
- Archive/unarchive should be simple file moves between Pi's sessions root and archive root, preserving the encoded project folder and session filename.
- Delete strategy: use `trash` CLI if available/successful; otherwise permanently delete after confirmation.
- Manager UI does not render the currently active session in the active sessions list. Use `/archive-session` or `/delete-session` for that.
- Current-session archive/delete command must create/switch to a new session before mutating old session file.
- Current-session destructive commands use native Pi confirm/select UI, not custom panel.
- Current-session archive/delete commands start with a blank editor after switching to the new session. Do not preserve unsent editor text.
- Bulk destructive confirmation uses the same pattern as `reference`: first action key sets footer ack text (`Delete N? Enter confirm · Esc cancel`), Enter executes, Esc cancels, other input ignored while ack is pending.
- `/manage-sessions` is management only. It does not resume/open sessions.
- Public commands approved: `/manage-sessions`, `/archive-session`, `/delete-session`.
- Public command added by user: `/clean-house`.
- Add docs for composing Tau shared TUI components under `docs/` because this creates reusable UI surface.

## Public surface

- `/manage-sessions`: open manager UI.
- `/archive-session`: archive current session after confirmation, then boot into new session first.
- `/delete-session`: delete current session after confirmation, then boot into new session first.
- `/clean-house`: choose archive/delete in a native Pi selection prompt, then confirm sweeping sessions older than one week.
- New documentation page for Tau TUI component composition. Candidate: `docs/tui-components.md`.

## Component details to resolve

### ToolPanel

- File candidate: `src/shared/tui/tool-panel.ts`.
- Inputs candidate:
  - `title: string`
  - `secondary?: string`
  - `header?: Component | string[]`
  - `body: Component`
  - `footer: ToolPanelFooter`
- `ToolPanelFooter` should support both normal hints and destructive ack text.
- Footer hint flow: child components expose default key hints as structured values; parent composes them with feature-specific hints and passes to `ToolPanel`.
- Candidate shared type: `ToolKeyHint = { kind: "raw"; key: string; label: string } | { kind: "binding"; binding: Keybinding; label: string } | { kind: "text"; text: string }`.
- `ToolPanel` renders `binding` via `keyHint`, `raw` via `rawKeyHint`, and joins with a dim separator.
- Destructive ack candidate: `footer: { kind: "ack"; message: string; confirmHint?: ToolKeyHint; cancelHint?: ToolKeyHint }` or a separate `acknowledgement?: string` field that replaces hints.
- Panel owns top/bottom border drawing, title/secondary styling, and footer wrapping.
- Panel does not constrain body height; body/list owns visible window.

### Tabs

- File candidate: `src/shared/tui/tabs.ts`.
- Inputs candidate:
  - `tabs: { id: string; label: string; count?: number }[]`
  - active tab id or index
  - `onChange(tabId)`
- Key handling: left/right and tab/shift+tab.
- Rendering only tab line. No body ownership.
- Prefer component/state hybrid: a `Tabs` component with `handleInput`, `render`, `getActiveTab()`, `setItems()`, and default key hints. Parent can forward input before/after list.
- `Tabs` should not know about multiselect or body content.

### MultiSelectList

- File candidate: `src/shared/tui/multi-select-list.ts`.
- Owns:
  - cursor movement
  - selection set
  - optional filter mode/input
  - clear selection
  - current item lookup
  - selected-or-current resolution
  - visible window
  - row rendering via caller callback
- Does not own:
  - tabs
  - panel shell
  - destructive confirmation UI beyond emitting action ids
  - file/session behavior
- Needs action shape. Candidate:
  - `actions: { id; key; label; requireItem?: boolean }[]`
  - returns/dispatches `{ kind: "action"; actionId; items; mode: "selection" | "cursor" | "older" }`
- Configure Shift+D and Shift+A as list actions with target mode `olderThanCursor`; do not hardcode session behavior in the list.
- Optional filter should be off by default; if enabled, plain typing feeds filter like SearchList.
- Need avoid `any`; generic item type must carry stable id through getter or item field.
- `MultiSelectList` exposes default key hints: move, select with space, clear with c, optional filter hints when filter enabled. Parent adds action hints.
- Selection is per list instance. For manage-sessions, active and archive tabs can each own one list instance so selections do not leak across tabs.
- Generic item candidate: `MultiSelectListItem = { id: string }`; caller supplies `renderItem(item, state, width)`.
- Row renderer state should include active/selected booleans and maybe `index`/`isDisabled`.

## manage-sessions behavior to resolve

- Session display name source: `session.name ?? session.firstMessage` from `SessionInfo`.
- Last updated source: `session.modified` from `SessionInfo`.
- Scope:
  - current scope lists sessions/archives only for `ctx.cwd`.
  - all scope lists sessions/archives for all projects.
  - header secondary line shows scope.
  - scope toggle clears selections because the item set changes.
- No resume/open behavior in manager.
- Archive operation:
  - move `.jsonl` from Pi sessions root to `session-archive/<encoded-project>/<session>.jsonl`.
  - preserve the encoded project folder and session filename.
- Unarchive operation:
  - move archived file from `session-archive/<encoded-project>/<session>.jsonl` back to Pi's sessions root at the same relative path.
- Delete operation:
  - use `trash` if installed/successful, else permanent file delete.
- Active/current session in manager:
  - exclude it from the active sessions list entirely.
- Empty states:
  - active tab: "No sessions."
  - archive tab: "No archived sessions."

### clean-house behavior

- Use Pi built-in selection prompt for action choice: archive or delete.
- Then use Pi built-in confirmation prompt showing action, cutoff, and count.
- Cutoff is `modified` older than 7 days.
- Operates on non-archived sessions only. It does not delete archived sessions.
- Scope is current folder only.
- Never touches the currently active session.

## Documentation plan

- Add `docs/tui-components.md`.
- Keep it product/dev-useful, not implementation dump.
- Cover when to use Pi built-ins first and when to use Tau shared components.
- Document composition:
  - `ToolPanel` for shell/header/footer.
  - `Tabs` for tab bar only.
  - `MultiSelectList` for selectable rows and default hints.
  - Components can expose `getKeyHints()` or equivalent so parents pass hints to `ToolPanel`.
- Include one short composition example, likely pseudo-ish TypeScript, not a whole feature.

## Open questions for user

- None currently blocking spec draft.

## Discarded options

- Reuse `TabbedMultiSelect`: too meta; combines filter/tabs/list, wrong component boundary.
- Build one manage-sessions-only giant component: fastest now, but blocks the shared TUI pieces explicitly requested.
- Migrate all similar UIs immediately: bigger scope, likely churn before shared shape is proven.
