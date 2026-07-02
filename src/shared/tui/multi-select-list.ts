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
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { renderFilterRow } from "./filter-row.ts";
import { bindingsHint, rawHint, type ToolKeyHint } from "./key-hints.ts";
import { clampIndex, visibleWindow } from "./viewport.ts";

export interface MultiSelectListItem {
	id: string;
}

export type MultiSelectActionTarget = "currentOrSelection" | "olderThanCursor";

export interface MultiSelectAction {
	id: string;
	key: KeyId;
	hint: ToolKeyHint;
	target: MultiSelectActionTarget;
}

export type MultiSelectResolvedTarget = "cursor" | "selection" | "olderThanCursor";

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
	}

	clearSelection(): void {
		this.selected.clear();
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
		const renderWidth = Math.max(1, width);
		const filtered = this.filteredItems();
		const lines: string[] = [];
		if (this.config.enableFilter && this.filterMode) lines.push(...this.renderFilter(renderWidth));

		if (filtered.length === 0) {
			lines.push(...wrapTextWithAnsi(this.theme.fg("muted", this.config.emptyMessage), renderWidth));
			return lines;
		}

		const { start, end } = visibleWindow(this.cursor, filtered.length, this.config.maxVisible);
		for (let index = start; index < end; index++) {
			const item = filtered[index];
			if (!item) continue;
			lines.push(...this.renderRow(item, index, renderWidth));
		}
		if (start > 0 || end < filtered.length) {
			lines.push(this.theme.fg("dim", `  (${this.cursor + 1}/${filtered.length})`));
		}
		return lines;
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
			return true;
		}
		return false;
	}

	private renderFilter(width: number): string[] {
		return [renderFilterRow(this.theme, this.filterInput, width)];
	}

	private renderRow(item: T, index: number, width: number): string[] {
		const state = { active: index === this.cursor, selected: this.selected.has(item.id), index };
		const marker = state.active ? this.theme.fg("accent", "› ") : "  ";
		const box = state.selected ? this.theme.fg("success", "[x]") : this.theme.fg("dim", "[ ]");
		const prefix = `${marker}${box} `;
		const prefixWidth = visibleWidth("› [ ] ");
		const content = this.config.renderItem(item, state, Math.max(1, width - prefixWidth));
		const indent = " ".repeat(prefixWidth);
		return content.map((line, lineIndex) =>
			truncateToWidth(`${lineIndex === 0 ? prefix : indent}${line}`, width, ""),
		);
	}

	private filteredItems(): readonly T[] {
		const query = this.filterInput.getValue().trim();
		if (!query) return this.items;
		return fuzzyFilter([...this.items], query, (item) => this.config.searchText(item));
	}

	private runAction(action: MultiSelectAction): void {
		const filtered = this.filteredItems();
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
}
