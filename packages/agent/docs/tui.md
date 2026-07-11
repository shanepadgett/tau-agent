# TUI

Build TUI that mirrors Pi aesthetics.

## Reach order

1. Use Pi native UI when it fits:
   - `ctx.ui.select()`
   - `ctx.ui.confirm()`
   - `ctx.ui.input()`
   - `ctx.ui.editor()`
   - `SelectList`
   - `SettingsList`
   - `BorderedLoader`
2. Use Tau shared TUI from `@shanepadgett/tau-tui` when a tool needs a custom component flow:
   - `ToolPanel`
   - `Tabs`
   - `SelectableList`
3. If shared TUI lacks the needed behavior, decide if the missing piece should become a new shared component in `@shanepadgett/tau-tui`.
4. Build feature-local custom UI only when reuse is unlikely.
5. Custom components still use Pi TUI primitives from `@earendil-works/pi-tui`.

No one-off visual language. Make it look like Pi.

## Shared components

### `ToolPanel`

Baseline shell for focused custom flows. Use when Pi built-ins do not fit and the user needs a bordered panel with title, header, body, footer key hints, or acknowledgement.

For footer hints, child components expose hints, the parent combines the visible hints, and `ToolPanel` renders them.

### `Tabs`

Use inside a `ToolPanel` when one focused flow has multiple related views. Keeps tab switching out of feature code.

### `SelectableList`

Use inside a `ToolPanel` when the user needs cursor movement, single-select or multi-select behavior, optional inline filtering, and actions over current/selected/visible/older rows.

Filtering is configured with `filter: { searchText }`. Filtered single-select lists focus the filter immediately, so plain typing goes into the filter and action keys must use modified keys like `ctrl+n` or non-printable keys like `delete`. Filtered multi-select lists keep list focus until `/` focuses the filter; `Enter` applies the filter focus, and `Escape` clears it.

Shared components should stay generic. Feature behavior stays in the feature.

## Composition shape

Keep composition small:

```ts
import { SelectableList, Tabs, ToolPanel } from "@shanepadgett/tau-tui";

const list = new SelectableList(theme, listConfig);
const archiveList = new SelectableList(theme, archiveListConfig);

const tabs = new Tabs(
 theme,
 [
  { id: "active", label: "Sessions", count: activeCount, body: list, getKeyHints: () => list.getKeyHints() },
  { id: "archive", label: "Archive", count: archiveCount, body: archiveList },
 ],
 "active",
);

const panel = new ToolPanel(theme, {
 title: "Manage sessions",
 secondary: "scope: current",
 body: tabs,
 footer: { kind: "hints", hints: tabs.getKeyHints() },
});
```

## Key hints

Use `ToolKeyHint` helpers. Use `bindingHint` for one configurable Pi keybinding and `bindingsHint` for grouped bindings like `tui.select.up` + `tui.select.down` rendering as one `move` hint. Use `rawHint` only for fixed local keys.

Interactive shared components expose their own `getKeyHints()`. Composite components include visible child hints through explicit child providers such as `TabItem.getKeyHints`. Parents add only currently available domain/modal actions, then pass the final list to `ToolPanel`.

Do not render disabled actions as key hints. Put non-action text in `secondary`, `header`, `body`, or an acknowledgement footer message.

Do not hardcode key checks or rendered key labels for configurable actions. Keep key handling and key hints tied to the same binding.

## Widgets

Use `ctx.ui.setWidget(...)` for persistent, glanceable UI near the editor.

Good fits:

- persistent tool list
- todo list
- progress/status block that should not take focus

Do not use a widget for a focused flow that needs input ownership. Use `ctx.ui.custom(...)` and a component.

## Rules

- Every `render(width)` line must fit `width`.
- Use `truncateToWidth()` or `wrapTextWithAnsi()` for styled text.
- Plain text renderers should use Pi `Text` with `new Text("", 0, 0)` so tool rows keep native spacing and wrapping.
- Custom components must never return raw unbounded content. Split lines and run each line through `truncateToWidth()` or `wrapTextWithAnsi()` before returning it.
- Truncating styled text can insert resets that break row backgrounds. Prefer wrapping for styled text unless the component owns the whole line background.
- Custom components must implement `invalidate()`, even if it is a no-op.
- Use `theme` from the TUI callback. Do not import theme globals.
- Call `tui.requestRender()` after state changes.
- Keep feature behavior outside shared components.
- Keep storage and network outside TUI components.
- Prefer one composed panel over one giant component.
- If a helper has one caller and no useful name, inline it.
