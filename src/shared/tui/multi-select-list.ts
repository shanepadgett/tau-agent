import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type Focusable,
	fuzzyFilter,
	getKeybindings,
	Input,
	Key,
	type KeyId,
	matchesKey,
} from "@earendil-works/pi-tui";
import { renderFilterRow } from "./filter-row.ts";
import { bindingsHint, rawHint, type ToolKeyHint } from "./key-hints.ts";
import { renderPrefixedRow, renderWindowedList } from "./list-render.ts";
import { clampIndex } from "./viewport.ts";

export interface MultiSelectListItem {
	id: string;
}

export type MultiSelectActionTarget = "current" | "currentOrSelection" | "visible" | "olderThanCursor";

export interface MultiSelectAction {
	id: string;
	key: KeyId;
	hint: ToolKeyHint;
	target: MultiSelectActionTarget;
}

export type MultiSelectResolvedTarget = "cursor" | "selection" | "visible" | "olderThanCursor";

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
	// Render row content only. MultiSelectList owns cursor and selection chrome.
	renderItem(item: T, state: MultiSelectRowState, width: number): string[];
	searchText(item: T): string;
	onAction(result: MultiSelectActionResult<T>): void;
	onSelectionChange(items: readonly T[]): void;
}

export class MultiSelectList<T extends MultiSelectListItem> implements Component, Focusable {
	private readonly theme: Theme;
	private readonly config: MultiSelectListConfig<T>;
	private readonly filterInput = new Input();
	private readonly selected = new Set<string>();
	private items: readonly T[];
	private cursor = 0;
	private filterMode = false;
	private _focused = false;

	constructor(theme: Theme, config: MultiSelectListConfig<T>) {
		this.theme = theme;
		this.config = config;
		this.items = config.items;
		this.filterInput.onSubmit = () => {
			this.filterMode = false;
			this.filterInput.focused = false;
			this.clampCursor();
		};
		this.filterInput.onEscape = () => {
			if (this.filterInput.getValue()) this.filterInput.setValue("");
			else {
				this.filterMode = false;
				this.filterInput.focused = false;
				this.clampCursor();
			}
			this.cursor = 0;
		};
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.filterInput.focused = value && this.filterMode;
	}

	setItems(items: readonly T[]): void {
		this.items = items;
		const ids = new Set(items.map((item) => item.id));
		for (const id of this.selected) {
			if (!ids.has(id)) this.selected.delete(id);
		}
		this.clampCursor();
		this.emitSelectionChange();
	}

	clearSelection(): void {
		this.selected.clear();
		this.emitSelectionChange();
	}

	setSelectedIds(ids: readonly string[]): void {
		const validIds = new Set(this.items.map((item) => item.id));
		this.selected.clear();
		for (const id of ids) {
			if (validIds.has(id)) this.selected.add(id);
		}
		this.emitSelectionChange();
	}

	getCurrentItem(): T | undefined {
		return this.filteredItems()[this.cursor];
	}

	isFiltering(): boolean {
		return this.filterMode;
	}

	getKeyHints(): ToolKeyHint[] {
		return [
			bindingsHint(["tui.select.up", "tui.select.down"], "move"),
			rawHint("Space", "select"),
			rawHint("c", "clear"),
			...(this.config.enableFilter ? [rawHint("f", "filter")] : []),
			...this.config.actions.map((action) => action.hint),
		];
	}

	handleInput(data: string): void {
		if (this.filterMode) {
			this.handleFilterInput(data);
			return;
		}

		if (this.handleListKey(data)) return;
		if (data === "c") {
			this.selected.clear();
			this.emitSelectionChange();
			return;
		}
		if (this.config.enableFilter && data === "f") {
			this.filterMode = true;
			this.filterInput.focused = this._focused;
			this.clampCursor();
			return;
		}

		for (const action of this.config.actions) {
			if (matchesKey(data, action.key)) {
				this.runAction(action);
				return;
			}
		}
	}

	render(width: number): string[] {
		return renderWindowedList(
			this.theme,
			this.filteredItems(),
			this.cursor,
			this.config.maxVisible,
			this.config.emptyMessage,
			width,
			(renderWidth) =>
				this.config.enableFilter && this.filterMode
					? [renderFilterRow(this.theme, this.filterInput, renderWidth)]
					: [],
			(item, index, renderWidth) => this.renderRow(item, index, renderWidth),
		);
	}

	invalidate(): void {}

	private handleFilterInput(data: string): void {
		if (this.handleListKey(data)) return;

		const previous = this.filterInput.getValue();
		this.filterInput.handleInput(data);
		if (this.filterInput.getValue() !== previous) this.cursor = 0;
		this.clampCursor();
	}

	private handleListKey(data: string): boolean {
		const keybindings = getKeybindings();
		if (keybindings.matches(data, "tui.select.up")) {
			const filtered = this.filteredItems();
			this.cursor = filtered.length === 0 ? 0 : Math.max(0, this.cursor - 1);
			return true;
		}
		if (keybindings.matches(data, "tui.select.down")) {
			const filtered = this.filteredItems();
			this.cursor = filtered.length === 0 ? 0 : Math.min(this.cursor + 1, filtered.length - 1);
			return true;
		}
		if (matchesKey(data, Key.space) || data === " ") {
			const item = this.filteredItems()[this.cursor];
			if (item && this.selected.has(item.id)) this.selected.delete(item.id);
			else if (item) this.selected.add(item.id);
			this.emitSelectionChange();
			return true;
		}
		return false;
	}

	private renderRow(item: T, index: number, width: number): string[] {
		const state = { active: index === this.cursor, selected: this.selected.has(item.id), index };
		const marker = state.active ? this.theme.fg("accent", "› ") : "  ";
		const box = state.selected ? this.theme.fg("success", "[x]") : this.theme.fg("dim", "[ ]");
		const prefix = `${marker}${box} `;
		return renderPrefixedRow(item, state, width, prefix, "› [ ] ", this.config.renderItem);
	}

	private filteredItems(): readonly T[] {
		const query = this.filterInput.getValue().trim();
		if (!query) return this.items;
		return fuzzyFilter([...this.items], query, (item) => this.config.searchText(item));
	}

	private runAction(action: MultiSelectAction): void {
		const filtered = this.filteredItems();
		if (action.target === "current") {
			const current = filtered[this.cursor];
			this.config.onAction({ actionId: action.id, items: current ? [current] : [], target: "cursor" });
			return;
		}

		if (action.target === "visible") {
			this.config.onAction({ actionId: action.id, items: filtered, target: "visible" });
			return;
		}

		if (action.target === "olderThanCursor") {
			this.config.onAction({
				actionId: action.id,
				items: filtered.slice(this.cursor + 1),
				target: "olderThanCursor",
			});
			return;
		}

		if (this.selected.size > 0) {
			this.config.onAction({
				actionId: action.id,
				items: this.items.filter((item) => this.selected.has(item.id)),
				target: "selection",
			});
			return;
		}

		const current = filtered[this.cursor];
		this.config.onAction({ actionId: action.id, items: current ? [current] : [], target: "cursor" });
	}

	private clampCursor(): void {
		this.cursor = clampIndex(this.cursor, this.filteredItems().length);
	}

	private emitSelectionChange(): void {
		this.config.onSelectionChange(this.items.filter((item) => this.selected.has(item.id)));
	}
}
