# manage-sessions tasks

## Task 1: shared panel shell and key hints

Build the base UI pieces that every tool panel can share.

Files:

- `src/shared/tui/tool-key-hints.ts`
- `src/shared/tui/tool-panel.ts`

Work:

- Add structured key hint types and rendering helpers.
- Add `ToolPanel` for title, optional secondary/header, body, footer hints, and footer acknowledgement.
- Keep all Pi key hint rendering in the hint helper.
- Do not add session-specific behavior.

Done:

- [x] `ToolKeyHint` helpers render binding, raw, and text hints.
- [x] `ToolPanel` renders shell/header/body/footer without owning tool state.
- [x] Footer can switch between normal hints and acknowledgement text.
- [x] `/tool-preview tool-panel` renders basic `ToolPanel` states for validation.
- [x] No production extension behavior changes.

## Task 2: shared tabs and multiselect list

Build focused reusable components for tab state and selectable row lists.

Files:

- `src/shared/tui/tabs.ts`
- `src/shared/tui/multi-select-list.ts`

Work:

- Add `Tabs` for tab rendering and Tab/Shift+Tab/left/right navigation.
- Add `MultiSelectList` for cursor movement, selection, optional filter, action dispatch, and visible windowing.
- Make both components expose default key hints for parent panels.
- Keep confirmation, file operations, and session behavior out.

Done:

- [x] `Tabs` owns only tab state/rendering and key handling.
- [x] `MultiSelectList` supports current-or-selection actions.
- [x] `MultiSelectList` supports older-than-cursor actions.
- [x] `MultiSelectList` clears selection and exposes key hints.
- [x] No reuse of `TabbedMultiSelect`.

## Task 3: shared TUI composition docs

Document the component boundary once the UI pieces exist.

Files:

- `docs/tui-components.md`

Work:

- Explain when to use Pi native UI first.
- Explain when to compose Tau `ToolPanel`, `Tabs`, and `MultiSelectList`.
- Show the key-hint flow from child component to panel footer.
- Include one short composition example.

Done:

- [x] Docs mention Pi built-ins before custom panels.
- [x] Docs describe each shared component boundary.
- [x] Docs include one compact composition example.
- [x] Docs avoid implementation dump.

## Task 4: manage-sessions storage operations

Build session listing and file mutations behind a small feature-local boundary.

Files:

- `src/extensions/manage-sessions/sessions.ts`

Work:

- List active sessions for current/all scope.
- List archived sessions for current/all scope.
- Exclude the active session when a current session file is supplied.
- Archive/unarchive by moving files between mirrored session/archive paths.
- Delete using trash first, then unlink fallback.

Done:

- [x] Active current/all listing works through Pi session APIs.
- [x] Archive current/all listing works from `session-archive`.
- [x] Archive/unarchive rejects unsafe relative paths and refuses overwrite.
- [x] Delete uses trash first and unlink fallback.
- [x] Store code has no UI concerns.

## Task 5: `/manage-sessions` panel

Compose the shared UI components into the bulk session manager.

Files:

- `src/extensions/manage-sessions/manager-ui.ts`
- `src/extensions/manage-sessions/index.ts`

Work:

- Register `/manage-sessions`.
- Open the manager only in TUI mode.
- Compose `ToolPanel`, `Tabs`, and two `MultiSelectList` instances.
- Support current/all scope with `s`.
- Support archive/delete/unarchive and older-than-cursor actions with inline footer acknowledgement.
- Keep Enter from resuming/opening sessions.

Done:

- [x] Manager opens on `/manage-sessions` in TUI mode.
- [x] Active/archive tabs render correct scoped counts.
- [x] `s` toggles current/all and clears selections.
- [x] Bulk actions require footer acknowledgement.
- [x] Completed actions refresh lists and keep panel open.
- [x] Current active session is not shown in active list.

## Task 6: current-session sweep command

Add the command-only flow that does not need the full manager panel.

Files:

- `src/extensions/manage-sessions/index.ts`

Work:

- Register `/sweep`.
- Use native Pi select/confirmation UI.
- Let the user choose archive or delete for the current session.
- Switch to a blank new session before mutating the old session file.

Done:

- [x] `/sweep` selects archive/delete before confirmation.
- [x] `/sweep` confirms, switches sessions, then archives or deletes the old session.
- [x] Cancelled `/sweep` does not switch or mutate files.
- [x] `/sweep` refuses when the current session is not persisted.

## Task 7: extension README and cleanup pass

Add user-facing docs and remove any accidental scaffolding.

Files:

- `src/extensions/manage-sessions/README.md`
- Any files touched by earlier tasks if cleanup is needed.

Work:

- Document commands and core keys at product level.
- Mention archive location conceptually.
- Remove dead helpers, unused exports, and stale TODOs.
- Do not add settings or Tau events.

Done:

- [ ] README covers `/manage-sessions` and `/sweep`.
- [ ] README lists core manager keys.
- [ ] README avoids implementation internals.
- [ ] No settings, schema edits, or event additions were introduced.
