# TUI Rework Working Plan

Ordered task list for the full Tau TUI rework. Check a top-level task only
after its implementation, cleanup, preview/story updates, and useful tests are
done. Keep one checkbox per task.

Read the relevant task before implementation. Read the whole file when the next
task depends on shared component behavior.

## Grounding

- `docs/tui.md`
- `.working/docs/tui-extension-inventory.md`
- Pi TUI docs: `/Users/shanepadgett/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/docs/tui.md`
- Pi keybinding docs: `/Users/shanepadgett/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/docs/keybindings.md`
- Strongest current shared pieces:
  - `src/shared/tui/tool-panel.ts`
  - `src/shared/tui/tabs.ts`
  - `src/shared/tui/multi-select-list.ts`

## Global decisions

- Use Pi built-ins first when they fit: `ctx.ui.select`, `confirm`, `input`,
  `editor`, `SelectList`, `SettingsList`, `BorderedLoader`, `Input`, `Editor`,
  `Text`, `Box`, `Container`, `Spacer`, `Markdown`, overlays, `setWidget`,
  `setFooter`, `matchesKey`, `Key`, injected `keybindings`, `keyHint`,
  `rawKeyHint`, and `keyText`.
- Build small shared primitives only where Pi built-ins do not carry the real
  use case.
- Shared owns mechanics: panel shell, tabs, list behavior, filter row rendering,
  viewport/cursor math, key hint rendering, compact status/message lines.
- Features own meaning and effects: data loading, git/filesystem/process work,
  destructive action semantics, row content, modal meaning, status text.
- Keep `ToolPanel` name for now. Docs already use it; rename churn does not pay.
- Do not build a loader, settings list, generic single-select list, modal
  framework, focus manager, app router, or layout framework.
- Lists own filtering state. `FilterRow` is a rendering/input helper, not an
  external filter controller.
- Shared components should receive injected keybindings from `ctx.ui.custom`
  instead of calling `getKeybindings()` internally.
- Tool rows and transcript/message renderers are compact Pi-native surfaces.
  Do not force `ToolPanel` into them.
- Animated/blinking dots only belong to live UI surfaces that can request
  renders. Static transcript messages render solid final state.

## Work order

- [x] **01. Shared TUI boundary and names**

  Files: `src/shared/tui/*`.

  Decide final shared surface before mass migration. Keep files focused and
  grep-friendly.

  Build or keep:

  - `tool-panel.ts`
  - `tabs.ts`
  - `multi-select-list.ts`
  - `action-select-list.ts`
  - `filter-row.ts`
  - `viewport.ts`
  - `key-hints.ts`
  - maybe `key-actions.ts` after migrations prove repeated handler/hint wiring
  - marker/message line primitive, likely replacing or extending
    `labeled-dot-line.ts`

  `tool-key-hints.ts` is now `key-hints.ts`. Collapse pieces always edited
  together. Split only when future work can touch one focused concept.

- [x] **02. `ToolPanel` shell and footer states**

  Files: `src/shared/tui/tool-panel.ts`,
  `.pi/extensions/tool-preview/widgets/tool-panel.ts`.

  `ToolPanel` owns frame, title, secondary text, optional header, body, footer
  hints, and ack footer states. It also owns destructive/info ack footer UI:
  message, confirm/cancel hints, and visual treatment. Callers provide pending
  message and actions; features still execute the real work.

  Do not put feature actions or data loading in the shell.

  Do not add a slot API. Coming callers need one body component, optional
  header, and footer state. Domain modes stay inside the caller-owned body.

- [x] **03. Shared key hints and key actions**

  Files: `src/shared/tui/key-hints.ts`, maybe future
  `src/shared/tui/key-actions.ts`.

  Use `bindingHint`/`bindingsHint` for configurable Pi actions and `rawHint`
  only for fixed local keys. Tie key detection and rendered hints together only
  if migrations prove repeated branching remains.

  Prefer injected keybindings passed through component constructors.

- [x] **04. `viewport.ts` and `filter-row.ts`**

  Files: `src/shared/tui/viewport.ts`, `src/shared/tui/filter-row.ts`.

  Do not stage these as unused foundation files. Add each one in the first task
  that wires a real consumer, unless that task gets too large and needs a small
  preparatory slice with a local Fallow suppression.

  `viewport.ts` owns pure cursor clamp and visible-window helpers.

  `FilterRow` wraps Pi `Input` label rendering and close/clear basics. It does
  not own filtered items, cursor clamp, list empty state, or action target
  resolution. Lists decide whether filtering is enabled, how matching works,
  and when filter mode opens/closes.

- [x] **05. `Tabs` update**

  Files: `src/shared/tui/tabs.ts`,
  `.pi/extensions/tool-preview/widgets/tabs-list.ts`.

  `Tabs` owns tab navigation, overflow, counts, active body delegation, and
  visible child hints. Compose tab hints with active child hints so feature
  screens stop hand-merging footers.

  Tab navigation uses fixed local keys: `Tab`, `Shift+Tab`, `←`, and `→`. Pi has
  no built-in tab navigation binding to reuse here. Keep raw hints intentional.

- [x] **06. `MultiSelectList` update**

  Files: `src/shared/tui/multi-select-list.ts`,
  `.pi/extensions/tool-preview/widgets/tabs-list.ts`.

  `MultiSelectList` owns cursor movement, optional filtering, selection, clear,
  action dispatch, visible windowing, row chrome, and key hints.

  It owns the active marker, selection marker, spacing, and base active/selected
  styling. Feature callers provide row content/details after the selection
  marker and any domain-specific width/drop behavior.

  Keep data loading and destructive work outside the component. Add a visible
  filtered-items action target if `reference` still needs update-visible.

- [ ] **07. `ActionSelectList`**

  Files: `src/shared/tui/action-select-list.ts`, plus stories in
  `.pi/extensions/tool-preview`.

  Build a narrow filtered single-select list for flows that need row actions and
  footer hints. Pi `SelectList` remains the default for plain pick-one flows.

  `ActionSelectList` owns active row marker, spacing, base active styling,
  optional filtering, cursor movement, primary enter action, per-row action
  dispatch, and `getKeyHints()`.

  It does not own title, frame, footer, or feature effects. Wrap it in
  `ToolPanel`. Feature callers provide row content/search text and perform
  edit/delete/discard/insert/pop after the list returns an action.

- [ ] **08. Shared compact marker/message primitives**

  Files: `src/shared/tui/labeled-dot-line.ts` or focused replacement such as
  `src/shared/tui/marker-line.ts`, plus `.pi/extensions/tool-preview` stories.

  Standardize dot + label + parts rendering for turn budget, soul/mode markers,
  silent command runner status, planning/mode inserts, and similar compact
  messages.

  Support solid final-state dots for transcript messages. Support optional
  animated/blinking dots only for live widgets/status components where the
  caller owns a timer and `requestRender()`.

  Add a shared custom-message box/snapshot shape only if it removes duplicate
  `Box`/`Text` title/body rendering without creating a message framework.

- [ ] **09. `.pi/extensions/tool-preview` storybook refresh**

  Files: `.pi/extensions/tool-preview/index.ts`,
  `.pi/extensions/tool-preview/README.md`,
  `.pi/extensions/tool-preview/widgets/*.ts`, likely new
  `.pi/extensions/tool-preview/stories.ts`,
  `.pi/extensions/tool-preview/widgets/preview-page.ts`, and
  `.pi/extensions/tool-preview/widgets/tool-row-preview.ts`.

  Make `tool-preview` the static visual storybook for shared components, tool
  rows, message/widget/footer rows, and tricky states.

  Command behavior:

  - `/tool-preview` opens a built-in Pi `SelectList` picker with filtering.
  - Running it closes any current preview first, then opens the picker.
  - Picker cancel leaves no preview open.
  - Cut `/tool-preview <story>` direct shortcuts.
  - Cut `/tool-preview clear`.

  Storybook shape:

  - one registry drives picker and dispatch
  - no duplicate `WIDGETS` and `ARGUMENTS`
  - static state stories by default
  - use real components/renderers only
  - scaffold state with setters or `handleInput()` when useful
  - show default, empty, selected, filtered, scrolled, long/narrow rows,
    destructive ack, info/error footer, active/inactive tabs, expanded/collapsed
    tool rows, and flicker-prone patch states
  - wrap every story in a `PreviewShell`, preferably using `ToolPanel`, with a
    bottom Escape hint for hiding the preview

  Do not add full interactivity unless a bug needs focus, IME cursor placement,
  keybinding remaps, tab/list event delegation, or ack lifecycle testing.

- [ ] **10. `manage-sessions` reference migration**

  Files: `src/extensions/manage-sessions/index.ts`,
  `src/extensions/manage-sessions/manager-ui.ts`.

  Keep custom flow. Do not replace with Pi built-ins. Multi-select plus
  current/selection/older archive/delete/unarchive actions are real behavior.

  Use this as reference migration, not a rewrite. Preserve UX while proving
  `ToolPanel`, `Tabs`, `MultiSelectList`, key hints, and injected keybindings.

  Move row chrome into `MultiSelectList`. Keep session row content local: name,
  cwd, age, message count, narrow-width drop behavior.

  Let `ToolPanel` carry destructive ack footer UI and shared hint composition.
  Do not share scope toggle, archive/delete/unarchive execution, reload, result
  messages, session row content, or pending action meaning. Consider sharing
  `shortenPath` only if reference/commit need the same home-path display.

- [ ] **11. `.pi/extensions/tau-context` migration**

  File: `.pi/extensions/tau-context/index.ts`.

  Keep scope narrow: select Tau resources and inject their files/manifests into
  the conversation for the agent.

  Do not show or add write-description, ideas, or stash source-selection flows.

  Replace `src/shared/tui/tabbed-multi-select.ts` with
  `ToolPanel + Tabs + MultiSelectList`. Delete `tabbed-multi-select.ts` after no
  callers remain.

- [ ] **12. `.pi/extensions/tau-new` and description prompt simplification**

  Files: `.pi/extensions/tau-new/index.ts`, `src/shared/description.ts`.

  Keep native Pi `select`, `input`, and `editor` where they fit.

  Cut the description source picker from `src/shared/description.ts`: no
  `Write description`, `Pull from ideas`, or `Pull from stash` step. Use the
  native editor directly for scaffold description.

  Remove `DescriptionPromptResult.source` and ideas/stash imports if no callers
  remain.

- [ ] **13. `ideas` and `stash` browsers**

  Files: `src/extensions/ideas/index.ts`, `src/extensions/ideas/browser.ts`,
  `src/extensions/stash/index.ts`, `src/extensions/stash/browser.ts`,
  `src/shared/tui/search-list.ts`.

  Replace `SearchList` with `ToolPanel + ActionSelectList`.

  Pi `SelectList` cannot handle one-key edit/delete/discard row actions without
  wrapper work that recreates a custom list.

  Keep editor/confirm/store behavior outside the list. Preserve `Alt+S` stash
  shortcut behavior while aligning hints and key handling.

  Delete `search-list.ts` after no callers remain.

- [ ] **14. `reference` flow**

  File: `src/extensions/reference/index.ts`.

  Extract the giant inline custom UI into focused pieces.

  Main screen is `ToolPanel + MultiSelectList<ReferenceItem>`. Keep filter state
  inside the list and use shared `FilterRow` for filter rendering/input.

  Use a `MultiSelectList` visible-target action if needed for current
  update-visible behavior.

  Use `ToolPanel` destructive ack for deleting selected/current references. Use
  a local panel mode with Pi `Input` for new git URL so clone progress can stay
  in the same screen. Render clone/update status in panel header/body, not as a
  fake selectable row unless multi-clone behavior is added.

  Try Pi `SelectList` for branch picker first. Use `ActionSelectList` only if
  branch rows need richer rendering than Pi can preserve.

  Keep git, filesystem, process spawning, and storage outside TUI components.

- [ ] **15. `commit` review flow**

  Files: `src/extensions/commit/index.ts`,
  `src/extensions/commit/review-ui.ts`.

  Keep custom flow. Pi built-ins do not fit the main commit plan review.

  Main review is `ToolPanel + ActionSelectList<CommitGroup>`. Rows show only
  commit subject plus file count, for example `fix(scope): message (12 files)`.
  Do not expand/render commit files inline in the main list.

  Do not add a separate file-preview widget. `ctx.ui.setWidget` is persistent
  app UI, does not own input, needs extra cleanup, and splits hints/state away
  from the focused flow.

  Use a single `f`/files action for the highlighted commit. It opens a file
  browser and serves both viewing and editing files.

  File browser is `ToolPanel + MultiSelectList` with filter enabled. It shows
  all dirty files, selected when assigned to the highlighted commit, with a
  muted owner hint for files assigned elsewhere. It renders a bounded window so
  huge change sets stay usable. Save applies the selected file set; cancel
  returns unchanged.

  Use embedded Pi `Editor`/`Input` inside the same panel for message editing and
  regeneration notes instead of bouncing to `ctx.ui.editor()` modal screens.
  Commit message editing needs `Editor` because breaking commit messages can be
  multiline; regeneration notes can use `Input`.

  Keep main actions: enter commit, `e` edit message, `f` files, `n` new commit,
  `r` regen message, `R` regen plan, `[`/`]` move, delete remove commit, esc
  cancel.

  Delete commit group should use `ToolPanel` ack. It does not delete files, but
  it is still easy to fat-finger.

- [ ] **16. `qna` flow**

  Files: `src/extensions/qna/index.ts`, `src/extensions/qna/ui.ts`.

  Keep custom QNA flow. Do not force `ActionSelectList` or `MultiSelectList`
  into it; QNA-specific behavior would require too many special hooks.

  Preserve public tool schema and result shape: selected values, custom answer,
  input answer, option notes, recommendation accepted flag, additional context,
  and abort behavior.

  Keep question/answer model in `model.ts`. Make UI components render and
  dispatch actions that the panel applies through model functions.

  Restructure into composable internal components:

  - `QnaPanel` owns `ToolPanel`, `QnaState`, submit/cancel, global/tab keys,
    and active-body routing
  - shared `Tabs` for question tabs plus Additional Context, with answered
    markers
  - `ChoiceQuestionBody` for select/multi/confirm option rows, descriptions,
    recommendation display, custom answer row, option notes, and option
    navigation
  - `InputQuestionBody` for typed answers
  - `AdditionalContextBody` for final optional context
  - `InlineEditorRow` for custom answers and option notes; reuse in commit only
    if it proves general enough later

  Use `ToolPanel` footer and shared key hints. Active body provides local hints;
  panel composes global hints such as tab navigation, submit, and cancel.

  Fix focus so only the active `Input`/`Editor` is focused. Current all-children
  focus behavior should die.

- [ ] **17. Explore tool row renderers**

  Files: `src/extensions/explore/autoread.ts`,
  `src/extensions/explore/find.ts`, `src/extensions/explore/grep.ts`,
  `src/extensions/explore/ls.ts`, `src/extensions/explore/read.ts`.

  Keep compact Pi-native rows. No `ToolPanel`. No expand key hints on tool
  rows; users can know the global expand binding.

  Standardize call summaries, expanded result behavior, width safety, and row
  state usage. Only change underlying key/input infrastructure if it is actually
  wrong.

- [ ] **18. Patch row renderer architecture and flicker fix**

  Files: `src/extensions/patch/index.ts`, `src/extensions/patch/render.ts`,
  `.pi/extensions/tool-preview/widgets/patch.ts`.

  Preserve current visual outcome.

  Refactor toward composable patch render parts:

  - call summary
  - section scan/summary
  - progress state dots/check/error
  - expanded result details
  - failure rendering

  Keep patch-specific scan/status logic local. Fix the small-screen transition
  flicker around applying/progress/checkmark states as part of the render
  architecture work.

  Add tool-preview stories for final patch states and transition/flicker-prone
  states.

- [ ] **19. Message renderers and compact status surfaces**

  Files: `src/extensions/silent-command-runner/index.ts`,
  `src/extensions/soul/modes/runtime.ts`,
  `src/extensions/turn-budget/index.ts`,
  `.pi/extensions/system-prompt-viewer/index.ts`, plus any planning/mode insert
  renderers found during audit.

  Keep message renderers bounded and visually consistent. Do not force
  `ToolPanel` into transcript rows.

  Use shared marker-line primitives for turn budget, soul/mode markers,
  planning/mode inserts, and silent command runner visible status.

  Move silent command runner away from `notify` for normal running/passed states.
  Show compact dot text for what is running and what finished. If blinking is
  needed while commands run, use a live widget/status component with caller-owned
  timer/requestRender; render completed state as a solid dot.

  Standardize system-prompt-viewer rendering into composable title/body/content
  pieces. Standardize agent-visible custom message content and user-visible
  renderer together so the title/body shape is not event-name-looking.

  Add tool-preview stories showing both user-visible rendering and agent-visible
  payload for these messages.

- [ ] **20. Footer composition**

  File: `src/extensions/footer/index.ts`.

  Keep this in the persistent footer lane. Preserve current content.

  Refactor into composable segments only where it clarifies: git summary,
  model/thinking, context/usage/cost, cwd/session, extension statuses, and Tau
  footer items.

  Keep refresh/event behavior explicit. Do not create a footer framework.
  Verify width safety, event ownership, footer item rendering, and cleanup.

- [ ] **21. Broad TUI standards audit**

  Files include `src/extensions/auto-name/index.ts`,
  `src/extensions/tau/index.ts`, `src/shared/model-fallback/index.ts`,
  `.pi/extensions/bash-toggle/index.ts`, `.pi/extensions/glm-xhigh/index.ts`,
  `.pi/extensions/tau-schema-sync/index.ts`, and any UI surface missed by the
  ordered tasks.

  Audit remaining native Pi built-ins, custom renderers, statuses,
  notifications, widgets, and message renderers. Leave Pi built-ins in place
  when they fit, but align wording, composition, key hints, status/notify use,
  render boundaries, and cleanup behavior with this plan.

  Do not rewrite native built-in flows for ceremony.

- [ ] **22. Cleanup and tests**

  Delete obsolete shared files after callers move:

  - `src/shared/tui/search-list.ts`
  - `src/shared/tui/tabbed-multi-select.ts`
  - feature-local `visibleWindow` helpers
  - stale feature-local footer/help renderers

  Prefer useful component/output tests over brittle giant screen snapshots.
  Existing likely touch points:

  - `test/extensions/explore/*.test.ts`
  - `test/extensions/explore/helpers.ts`
  - `test/shared/tool-row-state.test.ts`

  Add tests where they pay rent for shared components, row renderers, action
  targets, and width-safe output.

## Not primary TUI rework

- `src/extensions/attention/index.ts` — terminal notification behavior, not a
  focused TUI screen.
- `src/extensions/clear-screen/index.ts` — terminal clear behavior, not a TUI
  component.
- `src/extensions/soul/prompt.ts` — prompt text references TUI docs only.
