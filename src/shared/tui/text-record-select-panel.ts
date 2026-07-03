import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { formatAge, preview } from "../text.ts";
import {
	ActionSelectList,
	type ActionSelectListAction,
	type ActionSelectListItem,
	type ActionSelectListResult,
	type ActionSelectRowState,
} from "./action-select-list.ts";
import { ToolPanel } from "./tool-panel.ts";

export interface TextRecordSelectItem extends ActionSelectListItem {
	text: string;
	createdAt?: number;
}

export type TextRecordSelectResult<T extends TextRecordSelectItem> = ActionSelectListResult<T>;

export interface TextRecordSelectPanelConfig {
	title: string;
	path: string;
	emptyMessage: string;
	primaryLabel: string;
	actions: readonly ActionSelectListAction[];
	expandActiveItem: boolean;
}

export function createTextRecordSelectPanel<T extends TextRecordSelectItem>(
	theme: Theme,
	items: readonly T[],
	config: TextRecordSelectPanelConfig,
	done: (result: TextRecordSelectResult<T>) => void,
): Component {
	const list = new ActionSelectList(theme, {
		items,
		emptyMessage: config.emptyMessage,
		primaryLabel: config.primaryLabel,
		actions: config.actions,
		maxVisible: 12,
		renderItem: (item, state, width) => renderTextRecord(theme, item, state, config.expandActiveItem, width),
		searchText: (item) => item.text,
		onResult: done,
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
	state: ActionSelectRowState,
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
