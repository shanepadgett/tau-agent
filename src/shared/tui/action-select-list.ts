import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, type Focusable, getKeybindings, Input, type KeyId, matchesKey } from "@earendil-works/pi-tui";
import { renderFilterRow } from "./filter-row.ts";
import { bindingHint, bindingsHint, type ToolKeyHint } from "./key-hints.ts";
import { renderPrefixedRow, renderWindowedList } from "./list-render.ts";
import { clampIndex } from "./viewport.ts";

export interface ActionSelectListItem {
	id: string;
}

export interface ActionSelectListAction {
	id: string;
	key: KeyId;
	hint: ToolKeyHint;
}

export type ActionSelectListResult<T extends ActionSelectListItem> =
	| { kind: "cancel" }
	| { kind: "primary"; item: T }
	| { kind: "action"; actionId: string; item: T };

export interface ActionSelectRowState {
	active: boolean;
	index: number;
}

export interface ActionSelectListConfig<T extends ActionSelectListItem> {
	items: readonly T[];
	emptyMessage: string;
	primaryLabel: string;
	actions: readonly ActionSelectListAction[];
	maxVisible: number;
	// Render row content only. ActionSelectList owns cursor and filter chrome.
	renderItem(item: T, state: ActionSelectRowState, width: number): string[];
	searchText(item: T): string;
	onResult(result: ActionSelectListResult<T>): void;
}

export class ActionSelectList<T extends ActionSelectListItem> implements Component, Focusable {
	private readonly theme: Theme;
	private readonly config: ActionSelectListConfig<T>;
	private readonly filterInput = new Input();
	private cursor = 0;
	private _focused = false;

	constructor(theme: Theme, config: ActionSelectListConfig<T>) {
		this.theme = theme;
		this.config = config;
		this.filterInput.focused = true;
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.filterInput.focused = value;
	}

	setItems(items: readonly T[], activeId: string | undefined): void {
		this.config.items = items;
		if (activeId !== undefined) {
			const index = this.filteredItems().findIndex((item) => item.id === activeId);
			if (index >= 0) this.cursor = index;
		}
		this.clampCursor();
	}

	getCurrentItem(): T | undefined {
		return this.filteredItems()[this.cursor];
	}

	getKeyHints(): ToolKeyHint[] {
		return [
			bindingsHint(["tui.select.up", "tui.select.down"], "move"),
			bindingHint("tui.select.confirm", this.config.primaryLabel),
			...this.config.actions.map((action) => action.hint),
			bindingHint("tui.select.cancel", "cancel"),
		];
	}

	handleInput(data: string): void {
		const keybindings = getKeybindings();
		if (keybindings.matches(data, "tui.select.cancel")) {
			this.config.onResult({ kind: "cancel" });
			return;
		}

		const current = this.filteredItems()[this.cursor];
		if (keybindings.matches(data, "tui.select.confirm")) {
			if (current) this.config.onResult({ kind: "primary", item: current });
			return;
		}

		for (const action of this.config.actions) {
			if (matchesKey(data, action.key)) {
				if (current) this.config.onResult({ kind: "action", actionId: action.id, item: current });
				return;
			}
		}

		if (keybindings.matches(data, "tui.select.up")) {
			this.cursor = Math.max(0, this.cursor - 1);
			return;
		}
		if (keybindings.matches(data, "tui.select.down")) {
			this.cursor = clampIndex(this.cursor + 1, this.filteredItems().length);
			return;
		}

		this.filterInput.handleInput(data);
		this.clampCursor();
	}

	render(width: number): string[] {
		return renderWindowedList(
			this.theme,
			this.filteredItems(),
			this.cursor,
			this.config.maxVisible,
			this.config.emptyMessage,
			width,
			(renderWidth) => [renderFilterRow(this.theme, this.filterInput, renderWidth), ""],
			(item, index, renderWidth) => this.renderRow(item, index, renderWidth),
		);
	}

	invalidate(): void {}

	private renderRow(item: T, index: number, width: number): string[] {
		const state = { active: index === this.cursor, index };
		const prefix = state.active ? this.theme.fg("accent", "› ") : "  ";
		return renderPrefixedRow(item, state, width, prefix, "› ", this.config.renderItem);
	}

	private filteredItems(): readonly T[] {
		const query = this.filterInput.getValue().trim().toLowerCase();
		if (!query) return this.config.items;
		return this.config.items.filter((item) => this.config.searchText(item).toLowerCase().includes(query));
	}

	private clampCursor(): void {
		this.cursor = clampIndex(this.cursor, this.filteredItems().length);
	}
}
