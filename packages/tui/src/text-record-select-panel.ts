import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { formatAge, preview } from "./text.ts";
import {
	SelectableList,
	type SelectableListAction,
	type SelectableListItem,
	type SelectableListRowState,
} from "./selectable-list.ts";
import { ToolPanel } from "./tool-panel.ts";

export interface TextRecordSelectItem extends SelectableListItem {
	text: string;
	createdAt?: number;
}

export type TextRecordSelectResult<T extends TextRecordSelectItem> =
	| { kind: "cancel" }
	| { kind: "primary"; item: T }
	| { kind: "action"; actionId: string; item: T };

export interface TextRecordSelectPanelConfig {
	title: string;
	path: string;
	emptyMessage: string;
	primaryLabel: string;
	actions: readonly SelectableListAction[];
	expandActiveItem: boolean;
}

export function createTextRecordSelectPanel<T extends TextRecordSelectItem>(
	theme: Theme,
	items: readonly T[],
	config: TextRecordSelectPanelConfig,
	done: (result: TextRecordSelectResult<T>) => void,
): Component {
	const list = new SelectableList(theme, {
		items,
		emptyMessage: config.emptyMessage,
		selection: { kind: "single", primaryLabel: config.primaryLabel },
		filter: { searchText: (item) => item.text },
		actions: config.actions,
		cancelLabel: "cancel",
		maxVisible: 12,
		renderItem: (item, state, width) => renderTextRecord(theme, item, state, config.expandActiveItem, width),
		onResult: (result) => {
			if (result.kind === "cancel") {
				done(result);
				return;
			}
			const item = result.items[0];
			if (!item) return;
			done(
				result.kind === "primary" ? { kind: "primary", item } : { kind: "action", actionId: result.actionId, item },
			);
		},
	});
	const panel = new ToolPanel(theme, {
		title: config.title,
		secondary: `${items.length} total · ${config.path}`,
		body: list,
		footer: { kind: "hints", hints: list.getKeyHints() },
	});

	return {
		handleInput: (data) => list.handleInput(data),
		render: (width) => panel.render(width),
		invalidate: () => panel.invalidate(),
	};
}

function renderTextRecord(
	theme: Theme,
	item: TextRecordSelectItem,
	state: SelectableListRowState,
	expandActiveItem: boolean,
	width: number,
): string[] {
	const age = item.createdAt === undefined ? "" : theme.fg("dim", `  ${formatAge(item.createdAt)}`);
	if (!state.active || !expandActiveItem) {
		const label = theme.fg(state.active ? "accent" : "text", preview(item.text));
		return [truncateToWidth(`${label}${age}`, width, "")];
	}

	const body = wrapTextWithAnsi(theme.fg("accent", item.text), width);
	const lines = body.map((line) => truncateToWidth(line, width, ""));
	const lastIndex = lines.length - 1;
	if (age && lastIndex >= 0 && visibleWidth(lines[lastIndex] ?? "") + visibleWidth(age) <= width) {
		lines[lastIndex] = `${lines[lastIndex]}${age}`;
	}
	return lines;
}
