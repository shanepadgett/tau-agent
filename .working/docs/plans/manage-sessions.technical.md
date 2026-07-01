# manage-sessions technical

## References

Read these ranges first. Do not reread whole files unless the range is missing needed detail or code changed.

- Pi command/session APIs: `/Users/shanepadgett/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md:1130-1198`.
- Pi session storage docs: `/Users/shanepadgett/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/docs/session-format.md:1-15` and `:373-389`.
- `SessionInfo` type: `/Users/shanepadgett/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.d.ts:121-134`.
- Pi default session dir shape: `/Users/shanepadgett/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js:221-229`.
- Pi session listing behavior: `/Users/shanepadgett/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js:1176-1229`.
- Pi agent dir export: `/Users/shanepadgett/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/dist/index.d.ts:2` and `/Users/shanepadgett/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/dist/config.js:412-417`.
- Pi delete fallback pattern: `/Users/shanepadgett/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/session-selector.js:541-571`.
- Pi active-session delete refusal and inline delete confirmation shape: `/Users/shanepadgett/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/session-selector.js:319-329` and `:444-452`.
- Reference extension footer acknowledgement pattern: `src/extensions/reference/index.ts:540-556` and `:617-628`.
- Existing shared list component conventions: `src/shared/tui/search-list.ts:28-40`, `:50-153`, and `:192-202`.
- Text helpers for row labels and age: `src/shared/text.ts:1-17`.
- Existing command pattern with `waitForIdle()`: `src/extensions/ideas/index.ts:1-30` and `src/extensions/stash/index.ts:1-50`.

## Files

- Add `src/shared/tui/tool-key-hints.ts`.
- Add `src/shared/tui/tool-panel.ts`.
- Add `src/shared/tui/tabs.ts`.
- Add `src/shared/tui/multi-select-list.ts`.
- Add `src/extensions/manage-sessions/index.ts`.
- Add `src/extensions/manage-sessions/session-store.ts`.
- Add `src/extensions/manage-sessions/manager-ui.ts`.
- Add `src/extensions/manage-sessions/README.md`.
- Add `docs/tui-components.md`.
- Do not edit `src/shared/events.ts`; no Tau event is needed.
- Do not replace `src/shared/tui/tabbed-multi-select.ts` or migrate `tau-context` in this change.

## Shared TUI components

### `src/shared/tui/tool-key-hints.ts`

Own only hint data and rendering helpers.

Use `Keybinding` from `@earendil-works/pi-tui` for configured Pi/TUI keybindings, and `keyHint`/`rawKeyHint` from `@earendil-works/pi-coding-agent` for rendering.

Shape:

```ts
export type ToolKeyHint =
 | { kind: "binding"; binding: Keybinding; label: string }
 | { kind: "raw"; key: string; label: string }
 | { kind: "text"; text: string };

export function bindingHint(binding: Keybinding, label: string): ToolKeyHint;
export function rawHint(key: string, label: string): ToolKeyHint;
export function textHint(text: string): ToolKeyHint;
export function renderToolKeyHints(theme: Theme, hints: readonly ToolKeyHint[]): string;
```

`renderToolKeyHints` joins hints with a dim ` · `. Keep formatting here so panel, tabs, and list do not each reinvent hint rendering.

### `src/shared/tui/tool-panel.ts`

Own shell only: top border, title, optional secondary line, optional header content, body, footer, bottom border.

Use `Component` from `@earendil-works/pi-tui` and `Theme` from `@earendil-works/pi-coding-agent`.

Shape:

```ts
export type ToolPanelFooter =
 | { kind: "hints"; hints: readonly ToolKeyHint[] }
 | { kind: "ack"; message: string; hints: readonly ToolKeyHint[] };

export interface ToolPanelConfig {
 title: string;
 secondary?: string;
 header?: Component | readonly string[];
 body: Component;
 footer: ToolPanelFooter;
}
```

Implement as a component with a mutable config or explicit setters. Manager UI needs to update secondary text, body, and footer after scope/tab/action changes. Do not make callers rebuild the whole TUI custom component for every render.

Rendering rules:

- Every line must truncate/wrap to width.
- Top and bottom border use `theme.fg("border", "─".repeat(width))`.
- Title uses accent + bold.
- Secondary text uses muted/dim.
- Footer `ack` uses error color for the message and rendered hints for Enter/Esc.
- Footer `hints` uses `renderToolKeyHints`.

### `src/shared/tui/tabs.ts`

Own tab state and tab rendering only.

Shape:

```ts
export interface TabItem {
 id: string;
 label: string;
 count?: number;
}

export class Tabs implements Component {
 constructor(theme: Theme, tabs: readonly TabItem[], activeId: string);
 getActiveId(): string;
 setTabs(tabs: readonly TabItem[]): void;
 handleKey(data: string): boolean;
 getKeyHints(): ToolKeyHint[];
}
```

`handleKey` consumes left/right, Tab, and Shift+Tab. It returns whether it changed or consumed input. `handleInput` can delegate to `handleKey` for `Component` compatibility.

Do not put multiselect, body switching, or session behavior in `Tabs`.

### `src/shared/tui/multi-select-list.ts`

Own list state and action targeting.

Shape:

```ts
export interface MultiSelectListItem {
 id: string;
}

export type MultiSelectActionTarget = "currentOrSelection" | "olderThanCursor";

export interface MultiSelectAction {
 id: string;
 key: KeyId;
 hint: ToolKeyHint;
 target: MultiSelectActionTarget;
}

export type MultiSelectResolvedTarget = "cursor" | "selection" | "olderThanCursor";

export interface MultiSelectActionResult<T extends MultiSelectListItem> {
 actionId: string;
 items: readonly T[];
 target: MultiSelectResolvedTarget;
}

export interface MultiSelectRowState {
 active: boolean;
 selected: boolean;
 index: number;
}

export interface MultiSelectListConfig<T extends MultiSelectListItem> {
 items: readonly T[];
 emptyMessage: string;
 actions: readonly MultiSelectAction[];
 enableFilter: boolean;
 maxVisible: number;
 renderItem(item: T, state: MultiSelectRowState, width: number): string[];
 searchText(item: T): string;
 onAction(result: MultiSelectActionResult<T>): void;
}
```

Implementation rules:

- Use `Key.up`, `Key.down`, `Key.space`, `Key.escape`, `Key.enter`, `Key.shift("d")` style matching from `@earendil-works/pi-tui`.
- `Space` toggles current item.
- `c` clears selection.
- If `enableFilter` is true, `f` enters filter mode and plain typing feeds an `Input`; if false, plain typing is ignored.
- `currentOrSelection` resolves to selected items when selection is non-empty, else the cursor item when present.
- `olderThanCursor` resolves to items after the current cursor in the current filtered order. It does not include the cursor row.
- Actions with no target still call `onAction` with an empty `items` array; manager decides how to notify.
- Expose `setItems()`, `clearSelection()`, `getSelectionSize()`, and `getKeyHints()`.
- Do not own confirmation, tabs, panel shell, file ops, or session behavior.

## manage-sessions extension

### `src/extensions/manage-sessions/session-store.ts`

Own session file discovery and mutation.

Types:

```ts
export type SessionScope = "current" | "all";
export type SessionLocation = "active" | "archive";

export interface ManagedSession {
 id: string;
 path: string;
 name: string;
 cwd: string;
 modified: Date;
 messageCount: number;
 location: SessionLocation;
}
```

Functions:

- `getSessionsRoot(): string` returns `join(getAgentDir(), "sessions")`.
- `getArchiveRoot(): string` returns `join(getAgentDir(), "session-archive")`.
- `listManagedSessions(cwd: string, scope: SessionScope, currentSessionFile?: string): Promise<{ active: ManagedSession[]; archive: ManagedSession[] }>`.
- `archiveSession(sessionPath: string): Promise<void>`.
- `unarchiveSession(sessionPath: string): Promise<void>`.
- `deleteSessionFile(sessionPath: string): Promise<{ method: "trash" | "unlink" }>`.

Listing:

- Active current: `SessionManager.list(cwd)`.
- Active all: `SessionManager.listAll()`.
- Archive current: compute the archive project dir from `getDefaultSessionDir(cwd)` relative to sessions root, then call `SessionManager.list(cwd, archiveProjectDir)`.
- Archive all: read one-level subdirectories under archive root, call `SessionManager.listAll(projectArchiveDir)` for each, flatten, sort by `modified` descending.
- Exclude `currentSessionFile` from active results by comparing resolved paths.
- Convert display name with `session.name ?? session.firstMessage`.

Path safety:

- For archive, compute `relative(getSessionsRoot(), sessionPath)`. Reject absolute relative paths and `..` segments.
- For unarchive, compute `relative(getArchiveRoot(), sessionPath)`. Reject absolute relative paths and `..` segments.
- Create destination parent dirs with `mkdir(..., { recursive: true })`.
- Refuse overwrite when destination exists.
- Use `rename()` for archive/unarchive.

Delete:

- Try `spawnSync("trash", args)` first like Pi.
- Treat success or missing source after trash as success.
- Fall back to `unlink()`.
- Return method for notification details.
- Throw with a compact error message when both fail.

### `src/extensions/manage-sessions/manager-ui.ts`

Own the custom panel and interaction loop.

Expose:

```ts
export async function showSessionManager(ctx: ExtensionCommandContext): Promise<void>;
```

Use `ctx.ui.custom()` and compose:

- `ToolPanel`
- `Tabs`
- one `MultiSelectList<ManagedSession>` for active sessions
- one `MultiSelectList<ManagedSession>` for archived sessions

Tabs:

- `active` label `Sessions`.
- `archive` label `Archive`.
- Counts reflect current scope after current-session exclusion.

Scope:

- State starts as `"current"`.
- `s` toggles `"current"`/`"all"`.
- Toggle reloads lists and clears both selections.
- Secondary line should include scope and archive root or a short path when useful.

Actions:

- Active list actions:
  - `a`: archive current/selection.
  - `Shift+A`: archive older than cursor.
  - `d`: delete current/selection.
  - `Shift+D`: delete older than cursor.
- Archive list actions:
  - `u`: unarchive current/selection.
  - `Shift+U`: unarchive older than cursor.
  - `d`: delete current/selection.
  - `Shift+D`: delete older than cursor.

Confirmation:

- Store a pending action `{ kind, items }` in manager state.
- Footer becomes `ack` with message like `Archive 3 sessions?` and Enter/Esc hints.
- While pending, only Enter and Esc do anything.
- Enter executes the action, refreshes lists, clears selections for changed list, and keeps panel open.
- Esc clears the pending action.
- Empty action target should notify `No sessions selected.` or `No older sessions.` and not enter ack.

Rendering rows:

- Use `preview()` for session display name.
- Use `formatAge(session.modified.getTime())` for age.
- Show count only if it fits without crowding; requested minimum is name + age.
- Use `[x]`/`[ ]` selection boxes and accent active row like `reference`.

No resume behavior:

- Enter is only confirm while ack is pending.
- No `switchSession()` call from manager.

### `src/extensions/manage-sessions/index.ts`

Register commands:

- `/manage-sessions`
- `/archive-session`
- `/delete-session`
- `/clean-house`

For `/manage-sessions`:

- `await ctx.waitForIdle()`.
- Require `ctx.mode === "tui"`.
- Call `showSessionManager(ctx)`.

For current-session commands:

- `await ctx.waitForIdle()`.
- Require `ctx.hasUI` for confirmation.
- Read `const oldSessionFile = ctx.sessionManager.getSessionFile()` before switching.
- If missing, notify that the current session is not persisted.
- Confirm with native `ctx.ui.confirm()`.
- On confirm, call `ctx.newSession({ parentSession: oldSessionFile, withSession: async (newCtx) => { ... } })`.
- Inside `withSession`, archive/delete `oldSessionFile` and notify with `newCtx.ui.notify()`.
- Do not use the old command `ctx` after session replacement except checking the `result.cancelled` value.
- Do not preserve editor text.

For `/clean-house`:

- `await ctx.waitForIdle()`.
- Require `ctx.hasUI`.
- Use native `ctx.ui.select()` with archive/delete choices.
- Load current-folder active sessions only via `SessionManager.list(ctx.cwd)` or `listManagedSessions(ctx.cwd, "current", currentSessionFile).active`.
- Filter `modified.getTime() < Date.now() - 7 * 24 * 60 * 60 * 1000`.
- Exclude current session.
- If count is zero, notify and stop.
- Confirm with action + count.
- Execute archive/delete across the filtered sessions.
- Report success count and failure count.

## README

`src/extensions/manage-sessions/README.md` should stay product-level:

- What it does: manage saved Pi sessions.
- Why: bulk archive/delete/unarchive without using `/resume` as a cleanup tool.
- Commands: `/manage-sessions`, `/archive-session`, `/delete-session`, `/clean-house`.
- Core keys: Space, c, s, Tab/Shift+Tab, a/Shift+A, d/Shift+D, u/Shift+U, Enter/Esc for acknowledgement.
- Archive location: `~/.pi/agent/session-archive/` conceptually; say it is next to Pi's sessions folder.

No implementation internals beyond what users need.

## Docs

Add `docs/tui-components.md`.

Content:

- Start with: use Pi built-ins first (`select`, `confirm`, `input`, `editor`, `SelectList`) when they fit.
- Use Tau shared components when a custom tool-like panel needs a consistent shell, tabs, or multiselect rows.
- Document `ToolPanel`, `Tabs`, and `MultiSelectList` responsibilities.
- Document key-hint flow: child components expose default hints; parent combines and passes them to `ToolPanel`.
- Include one short composition example. Keep it small.

## Cleanup and constraints

- Do not add settings.
- Do not add Tau events.
- Do not edit `schemas/tau.schema.json`.
- Do not migrate existing extensions in this change.
- Use strict TypeScript. No `any`. No non-null assertions.
- If a helper is used only once and its name does not clarify a boundary, inline it.
