# TUI Extension Inventory

Inventory of Tau extensions and local `.pi` extensions that touch TUI rendering, keyboard input, key hints, widgets, native UI prompts, status, notifications, or terminal-specific behavior.

## Core shared TUI files

- `src/shared/tui/labeled-dot-line.ts` — custom `Component`, `render(width)`.
- `src/shared/tui/multi-select-list.ts` — keyboard list, selection, filtering, key hints.
- `src/shared/tui/search-list.ts` — custom picker and keyboard input.
- `src/shared/tui/tabbed-multi-select.ts` — tabs plus multi-select keyboard UI.
- `src/shared/tui/tabs.ts` — tab switching and key hints.
- `src/shared/tui/tool-key-hints.ts` — `keyHint`, `rawKeyHint`, and binding hint helpers.
- `src/shared/tui/tool-panel.ts` — framed panel renderer and footer hints.

## First-party extensions with custom rendering or keyboard handling

- `src/extensions/commit/index.ts` — launches TUI review, native confirm/status/notify.
- `src/extensions/commit/review-ui.ts` — custom commit review TUI using `ctx.ui.custom`, `handleInput`, `matchesKey`, `keyHint`, `rawKeyHint`, and custom renderers.
- `src/extensions/explore/autoread.ts` — `registerMessageRenderer`, custom row component.
- `src/extensions/explore/find.ts` — tool `renderCall` and `renderResult`.
- `src/extensions/explore/grep.ts` — tool `renderCall` and `renderResult`.
- `src/extensions/explore/ls.ts` — tool `renderCall` and `renderResult`.
- `src/extensions/explore/read.ts` — wraps Pi read renderer and adds custom call summary.
- `src/extensions/footer/index.ts` — custom footer via `ctx.ui.setFooter`, `render(width)`.
- `src/extensions/ideas/browser.ts` — shared `SearchList`, custom keyboard picker.
- `src/extensions/ideas/index.ts` — TUI mode branch, editor text, notify.
- `src/extensions/manage-sessions/index.ts` — native select/confirm/notify.
- `src/extensions/manage-sessions/manager-ui.ts` — custom session manager TUI, tabs, list, key hints, keyboard handling.
- `src/extensions/patch/index.ts` — patch tool render hooks.
- `src/extensions/patch/render.ts` — custom patch row rendering.
- `src/extensions/qna/index.ts` — tool renderers and custom QNA UI launcher.
- `src/extensions/qna/ui.ts` — custom keyboard UI for interviews/questions.
- `src/extensions/reference/index.ts` — custom reference picker TUI, keyboard input, key hints, autocomplete item type.
- `src/extensions/silent-command-runner/index.ts` — `registerMessageRenderer`, `keyText` expand hint.
- `src/extensions/soul/modes/runtime.ts` — mode marker message renderers.
- `src/extensions/stash/browser.ts` — shared `SearchList`, custom keyboard picker.
- `src/extensions/stash/index.ts` — `registerShortcut(Key.alt("s"))`, editor text, notify.
- `src/extensions/turn-budget/index.ts` — message renderer.

## First-party extensions using native UI only or terminal behavior

- `src/extensions/attention/index.ts` — terminal OSC notification output.
- `src/extensions/auto-name/index.ts` — status and notify.
- `src/extensions/clear-screen/index.ts` — terminal clear escape sequence.
- `src/extensions/tau/index.ts` — native select/notify.
- `src/shared/description.ts` — native editor/select.
- `src/shared/model-fallback/index.ts` — status/notify.

## Local `.pi/extensions` with TUI, rendering, widgets, or key handling

- `.pi/extensions/system-prompt-viewer/index.ts` — `registerMessageRenderer`, `Box`, `Text`, `keyText`.
- `.pi/extensions/tau-context/index.ts` — custom `TabbedMultiSelect`.
- `.pi/extensions/tau-new/index.ts` — native select/input/notify, TUI-only guard.
- `.pi/extensions/tool-preview/index.ts` — preview widget, `ctx.ui.setWidget`, `onTerminalInput`, `matchesKey(escape)`.
- `.pi/extensions/tool-preview/widgets/autoread.ts`
- `.pi/extensions/tool-preview/widgets/find.ts`
- `.pi/extensions/tool-preview/widgets/grep.ts`
- `.pi/extensions/tool-preview/widgets/layout.ts`
- `.pi/extensions/tool-preview/widgets/ls.ts`
- `.pi/extensions/tool-preview/widgets/patch.ts`
- `.pi/extensions/tool-preview/widgets/read.ts`
- `.pi/extensions/tool-preview/widgets/tabs-list.ts`
- `.pi/extensions/tool-preview/widgets/tool-panel.ts`
- `.pi/extensions/tool-preview/widgets/tool-preview.ts`
- `.pi/extensions/tool-preview/widgets/turn-budget.ts`

## Local `.pi/extensions` using native UI notify only

- `.pi/extensions/bash-toggle/index.ts`
- `.pi/extensions/glm-xhigh/index.ts`
- `.pi/extensions/tau-schema-sync/index.ts`

## TUI/rendering tests

- `test/extensions/explore/helpers.ts`
- `test/extensions/explore/find.test.ts`
- `test/extensions/explore/grep.test.ts`
- `test/extensions/explore/ls.test.ts`
- `test/extensions/explore/read.test.ts`
- `test/shared/tool-row-state.test.ts`

## Low or no TUI relevance

- `src/extensions/soul/prompt.ts` only mentions TUI docs in prompt text.
- Most non-UI helper files under extension directories support the extension logic but do not directly handle TUI rendering, keyboard input, widgets, status, notifications, or key hints.
