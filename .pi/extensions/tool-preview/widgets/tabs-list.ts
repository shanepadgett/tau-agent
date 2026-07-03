import type { Theme } from "@earendil-works/pi-coding-agent";
import { Container, Key, Spacer, Text, type TUI, truncateToWidth } from "@earendil-works/pi-tui";
import { rawHint } from "../../../../src/shared/tui/key-hints.ts";
import { SelectableList, type SelectableListItem } from "../../../../src/shared/tui/selectable-list.ts";
import { Tabs } from "../../../../src/shared/tui/tabs.ts";
import { ToolPanel } from "../../../../src/shared/tui/tool-panel.ts";

interface PreviewSession extends SelectableListItem {
	name: string;
	age: string;
}

const ITEMS: readonly PreviewSession[] = [
	{ id: "1", name: "Plan manage-sessions UI", age: "3m ago" },
	{ id: "2", name: "Debug archive path handling", age: "2h ago" },
	{ id: "3", name: "Review stale project sessions", age: "1d ago" },
	{ id: "4", name: "Long row label shows truncation in narrow panes", age: "5d ago" },
];

export function createTabsListPreviewWidget(_tui: TUI, _cwd: string, theme: Theme): Container {
	const container = new Container();
	container.addChild(new Text(theme.fg("text", theme.bold("Tabs + SelectableList Preview")), 0, 0));
	container.addChild(new Spacer(1));
	const list = new SelectableList(theme, {
		items: ITEMS,
		emptyMessage: "No sessions found.",
		selection: { kind: "multi" },
		filter: { searchText: (item) => item.name },
		maxVisible: 3,
		actions: [
			{ id: "archive", key: Key.ctrl("a"), hint: rawHint("ctrl+a", "archive"), target: "currentOrSelection" },
			{
				id: "archiveOlder",
				key: Key.ctrlShift("a"),
				hint: rawHint("ctrl+A", "archive older"),
				target: "olderThanCursor",
			},
		],
		renderItem(item, state, width) {
			const name = theme.fg(state.active ? "accent" : "text", state.active ? theme.bold(item.name) : item.name);
			const age = theme.fg("dim", ` ${item.age}`);
			return [truncateToWidth(`${name}${age}`, width, "")];
		},
		onResult() {},
		onSelectionChange() {},
	});
	list.setItems(ITEMS);

	const archived = new Text(theme.fg("muted", "Archive tab can render any Component."));
	const tabs = new Tabs(
		theme,
		[
			{ id: "active", label: "Sessions", count: 12, body: list, getKeyHints: () => list.getKeyHints() },
			{ id: "archive", label: "Archive", count: 48, body: archived },
		],
		"active",
	);

	container.addChild(
		new ToolPanel(theme, {
			title: "Shared list composition",
			secondary: `active tab: ${tabs.getActiveId()}`,
			body: tabs,
			footer: { kind: "hints", hints: tabs.getKeyHints() },
		}),
	);
	return container;
}
