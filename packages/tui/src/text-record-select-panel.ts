import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	getKeybindings,
	truncateToWidth,
	type TUI,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { bindingHint } from "./key-hints.ts";
import { formatAge, preview } from "./text.ts";
import {
	SelectableList,
	type SelectableListAction,
	type SelectableListItem,
	type SelectableListRowState,
} from "./selectable-list.ts";
import { ToolPanel, type ToolPanelConfig } from "./tool-panel.ts";

export interface TextRecordSelectItem extends SelectableListItem {
	text: string;
	createdAt?: number;
}

export type TextRecordSelectResult<T extends TextRecordSelectItem> =
	| { kind: "cancel" }
	| { kind: "primary"; item: T }
	| { kind: "action"; actionId: string; item: T };

export interface TextRecordDestructiveAction<T extends TextRecordSelectItem> extends SelectableListAction {
	confirmLabel(item: T): string;
	runningLabel: string;
	onConfirm(item: T): Promise<readonly T[]>;
	onError(error: unknown): void;
}

export interface TextRecordSelectPanelConfig<T extends TextRecordSelectItem> {
	title: string;
	path: string;
	emptyMessage: string;
	primaryLabel: string;
	actions: readonly SelectableListAction[];
	destructiveAction: TextRecordDestructiveAction<T>;
	expandActiveItem: boolean;
}

export function createTextRecordSelectPanel<T extends TextRecordSelectItem>(
	tui: TUI,
	theme: Theme,
	items: readonly T[],
	config: TextRecordSelectPanelConfig<T>,
	done: (result: TextRecordSelectResult<T>) => void,
): Component {
	let currentItems = items;
	let destructiveState: { item: T; running: boolean } | undefined;
	const list = new SelectableList(theme, {
		items,
		emptyMessage: config.emptyMessage,
		selection: { kind: "single", primaryLabel: config.primaryLabel },
		filter: { searchText: (item) => item.text },
		actions: [...config.actions, config.destructiveAction],
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
			if (result.kind === "action" && result.actionId === config.destructiveAction.id) {
				destructiveState = { item, running: false };
				syncPanel();
				return;
			}
			done(
				result.kind === "primary" ? { kind: "primary", item } : { kind: "action", actionId: result.actionId, item },
			);
		},
	});
	const panelConfig: ToolPanelConfig = {
		title: config.title,
		secondary: `${items.length} total · ${config.path}`,
		body: list,
		footer: { kind: "hints", hints: list.getKeyHints() },
	};
	const panel = new ToolPanel(theme, panelConfig);

	function syncPanel(): void {
		panelConfig.secondary = `${currentItems.length} total · ${config.path}`;
		panelConfig.footer = destructiveState
			? destructiveState.running
				? { kind: "infoAck", message: config.destructiveAction.runningLabel, hints: [] }
				: {
						kind: "destructiveAck",
						message: config.destructiveAction.confirmLabel(destructiveState.item),
						hints: [bindingHint("tui.select.confirm", "confirm"), bindingHint("tui.select.cancel", "cancel")],
					}
			: { kind: "hints", hints: list.getKeyHints() };
		tui.requestRender();
	}

	async function confirmDestructive(item: T): Promise<void> {
		try {
			currentItems = await config.destructiveAction.onConfirm(item);
			list.setItems(currentItems);
		} catch (error) {
			config.destructiveAction.onError(error);
		}
		destructiveState = undefined;
		syncPanel();
	}

	return {
		handleInput: (data) => {
			if (!destructiveState) {
				list.handleInput(data);
				return;
			}
			if (destructiveState.running) return;
			const keybindings = getKeybindings();
			if (keybindings.matches(data, "tui.select.confirm")) {
				const item = destructiveState.item;
				destructiveState.running = true;
				syncPanel();
				void confirmDestructive(item);
				return;
			}
			if (keybindings.matches(data, "tui.select.cancel")) {
				destructiveState = undefined;
				syncPanel();
			}
		},
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
