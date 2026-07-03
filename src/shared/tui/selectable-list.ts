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
import { bindingHint, bindingsHint, rawHint, type ToolKeyHint } from "./key-hints.ts";
import { renderPrefixedRow, renderWindowedList } from "./list-render.ts";
import { clampIndex } from "./viewport.ts";

const NON_PRINTABLE_KEYS = new Set<string>([
	"escape",
	"esc",
	"enter",
	"return",
	"tab",
	"backspace",
	"delete",
	"insert",
	"clear",
	"home",
	"end",
	"pageUp",
	"pageDown",
	"up",
	"down",
	"left",
	"right",
	"f1",
	"f2",
	"f3",
	"f4",
	"f5",
	"f6",
	"f7",
	"f8",
	"f9",
	"f10",
	"f11",
	"f12",
]);

export interface SelectableListItem {
	id: string;
}

export type SelectableListActionTarget = "current" | "currentOrSelection" | "visible" | "olderThanCursor";
export type SelectableListResolvedTarget = "cursor" | "selection" | "visible" | "olderThanCursor";

export interface SelectableListAction {
	id: string;
	key: KeyId;
	hint: ToolKeyHint;
	target?: SelectableListActionTarget;
}

export interface SelectableListActionResult<T extends SelectableListItem> {
	actionId: string;
	items: readonly T[];
	target: SelectableListResolvedTarget;
}

export type SelectableListResult<T extends SelectableListItem> =
	| { kind: "cancel" }
	| { kind: "primary"; items: readonly T[]; target: SelectableListResolvedTarget }
	| ({ kind: "action" } & SelectableListActionResult<T>);

export interface SelectableListRowState {
	active: boolean;
	selected: boolean;
	index: number;
}

export type SelectableListSelection =
	| { kind: "single"; primaryLabel: string }
	| { kind: "multi"; primaryLabel?: string };

export interface SelectableListFilter<T extends SelectableListItem> {
	searchText(item: T): string;
}

export interface SelectableListConfig<T extends SelectableListItem> {
	items: readonly T[];
	emptyMessage: string;
	selection: SelectableListSelection;
	filter?: SelectableListFilter<T>;
	actions: readonly SelectableListAction[];
	cancelLabel?: string;
	maxVisible: number;
	// Render row content only. SelectableList owns cursor, selection, and filter chrome.
	renderItem(item: T, state: SelectableListRowState, width: number): string[];
	onResult(result: SelectableListResult<T>): void;
	onSelectionChange?: (items: readonly T[]) => void;
}

export class SelectableList<T extends SelectableListItem> implements Component, Focusable {
	private readonly theme: Theme;
	private readonly config: SelectableListConfig<T>;
	private readonly filterInput = new Input();
	private readonly selected = new Set<string>();
	private items: readonly T[];
	private cursor = 0;
	private filterActive: boolean;
	private _focused = false;

	constructor(theme: Theme, config: SelectableListConfig<T>) {
		this.theme = theme;
		this.config = config;
		this.items = config.items;
		this.filterActive = config.filter !== undefined && config.selection.kind === "single";
		this.filterInput.focused = this.filterActive;
		assertFilterSafeActions(config.actions, config.filter !== undefined && config.selection.kind === "single");
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.filterInput.focused = value && this.filterActive;
	}

	setItems(items: readonly T[], activeId?: string): void {
		this.items = items;
		const ids = new Set(items.map((item) => item.id));
		for (const id of this.selected) {
			if (!ids.has(id)) this.selected.delete(id);
		}
		if (activeId !== undefined) {
			const index = this.filteredItems().findIndex((item) => item.id === activeId);
			if (index >= 0) this.cursor = index;
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

	isFilterFocused(): boolean {
		return this.config.selection.kind === "multi" && this.filterActive;
	}

	getKeyHints(): ToolKeyHint[] {
		if (this.isFilterFocused()) {
			return [
				bindingsHint(["tui.select.up", "tui.select.down"], "move"),
				rawHint("Enter", "apply filter"),
				rawHint("Esc", "cancel filter"),
				rawHint("ctrl+c", "clear filter"),
			];
		}

		const primaryLabel = this.config.selection.primaryLabel;
		return [
			bindingsHint(["tui.select.up", "tui.select.down"], "move"),
			...(primaryLabel ? [bindingHint("tui.select.confirm", primaryLabel)] : []),
			...(this.config.selection.kind === "multi" ? this.multiSelectHints() : []),
			...this.config.actions.map((action) => action.hint),
			...(this.config.cancelLabel ? [bindingHint("tui.select.cancel", this.config.cancelLabel)] : []),
		];
	}

	handleInput(data: string): void {
		const keybindings = getKeybindings();
		if (this.config.selection.kind === "multi" && this.filterActive && matchesKey(data, Key.ctrl("c"))) {
			this.clearFilter();
			return;
		}
		if (
			this.config.selection.kind === "multi" &&
			this.filterActive &&
			keybindings.matches(data, "tui.select.cancel")
		) {
			this.clearFilterFocus();
			return;
		}
		if (
			this.config.selection.kind === "multi" &&
			this.filterActive &&
			keybindings.matches(data, "tui.select.confirm")
		) {
			this.blurFilter();
			return;
		}
		if (keybindings.matches(data, "tui.select.cancel")) {
			this.config.onResult({ kind: "cancel" });
			return;
		}

		if (keybindings.matches(data, "tui.select.confirm")) {
			this.primary();
			return;
		}

		if (this.handleListKey(data)) return;
		if (this.config.selection.kind === "multi" && this.handleMultiSelectKey(data)) return;
		if (
			this.config.selection.kind === "multi" &&
			this.config.filter &&
			!this.filterActive &&
			matchesKey(data, Key.slash)
		) {
			this.activateFilter();
			return;
		}
		if (this.config.selection.kind === "multi" && this.filterActive) {
			this.handleFilterInput(data);
			return;
		}

		for (const action of this.config.actions) {
			if (matchesKey(data, action.key)) {
				this.runAction(action);
				return;
			}
		}

		if (this.config.filter && this.config.selection.kind === "single") this.handleFilterInput(data);
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
				this.config.filter
					? [renderFilterRow(this.theme, this.filterInput, renderWidth, this.filterActive), ""]
					: [],
			(item, index, renderWidth) => this.renderRow(item, index, renderWidth),
		);
	}

	invalidate(): void {}

	private multiSelectHints(): ToolKeyHint[] {
		if (!this.config.filter) return [rawHint("Space", "select"), rawHint("c", "clear")];
		return this.filterActive
			? [rawHint("Enter", "apply filter"), rawHint("Esc", "cancel filter"), rawHint("ctrl+c", "clear filter")]
			: [rawHint("Space", "select"), rawHint("c", "clear"), rawHint("/", "filter")];
	}

	private primary(): void {
		const filtered = this.filteredItems();
		if (this.config.selection.kind === "multi") {
			this.config.onResult({
				kind: "primary",
				items: this.items.filter((item) => this.selected.has(item.id)),
				target: "selection",
			});
			return;
		}

		const current = filtered[this.cursor];
		this.config.onResult({ kind: "primary", items: current ? [current] : [], target: "cursor" });
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
		return false;
	}

	private handleMultiSelectKey(data: string): boolean {
		const filterCapturesText = this.config.filter && this.filterActive;
		const toggleKey = Key.space;
		const clearKey = filterCapturesText ? Key.ctrl("c") : "c";
		if (filterCapturesText && matchesKey(data, clearKey)) {
			this.clearFilter();
			return true;
		}
		if (filterCapturesText) return false;
		if (matchesKey(data, toggleKey) || (!filterCapturesText && data === " ")) {
			const item = this.filteredItems()[this.cursor];
			if (item && this.selected.has(item.id)) this.selected.delete(item.id);
			else if (item) this.selected.add(item.id);
			this.emitSelectionChange();
			return true;
		}
		if (matchesKey(data, clearKey)) {
			this.selected.clear();
			this.emitSelectionChange();
			return true;
		}
		return false;
	}

	private handleFilterInput(data: string): void {
		const previous = this.filterInput.getValue();
		this.filterInput.handleInput(data);
		if (this.filterInput.getValue() !== previous) this.cursor = 0;
		this.clampCursor();
	}

	private activateFilter(): void {
		this.filterActive = true;
		this.filterInput.focused = this._focused;
		this.clampCursor();
	}

	private blurFilter(): void {
		this.filterActive = false;
		this.filterInput.focused = false;
		this.clampCursor();
	}

	private clearFilter(): void {
		this.filterInput.setValue("");
		this.cursor = 0;
		this.clampCursor();
	}

	private clearFilterFocus(): void {
		this.clearFilter();
		this.blurFilter();
	}

	private renderRow(item: T, index: number, width: number): string[] {
		const state = { active: index === this.cursor, selected: this.selected.has(item.id), index };
		const prefix = this.config.selection.kind === "multi" ? this.multiPrefix(state) : this.singlePrefix(state);
		const placeholder = this.config.selection.kind === "multi" ? "› [ ] " : "› ";
		return renderPrefixedRow(item, state, width, prefix, placeholder, this.config.renderItem);
	}

	private singlePrefix(state: SelectableListRowState): string {
		return state.active ? this.theme.fg("accent", "› ") : "  ";
	}

	private multiPrefix(state: SelectableListRowState): string {
		const marker = state.active ? this.theme.fg("accent", "› ") : "  ";
		const box = state.selected ? this.theme.fg("success", "[x]") : this.theme.fg("dim", "[ ]");
		return `${marker}${box} `;
	}

	private filteredItems(): readonly T[] {
		const filter = this.config.filter;
		if (!filter) return this.items;
		const query = this.filterInput.getValue().trim();
		if (!query) return this.items;
		return fuzzyFilter([...this.items], query, filter.searchText);
	}

	private runAction(action: SelectableListAction): void {
		const resolved = this.resolveTarget(action.target ?? "current");
		this.config.onResult({ kind: "action", actionId: action.id, items: resolved.items, target: resolved.target });
	}

	private resolveTarget(target: SelectableListActionTarget): {
		items: readonly T[];
		target: SelectableListResolvedTarget;
	} {
		const filtered = this.filteredItems();
		if (target === "visible") return { items: filtered, target: "visible" };
		if (target === "olderThanCursor") return { items: filtered.slice(this.cursor + 1), target: "olderThanCursor" };
		if (target === "currentOrSelection" && this.selected.size > 0) {
			return { items: this.items.filter((item) => this.selected.has(item.id)), target: "selection" };
		}
		const current = filtered[this.cursor];
		return { items: current ? [current] : [], target: "cursor" };
	}

	private clampCursor(): void {
		this.cursor = clampIndex(this.cursor, this.filteredItems().length);
	}

	private emitSelectionChange(): void {
		this.config.onSelectionChange?.(this.items.filter((item) => this.selected.has(item.id)));
	}
}

function assertFilterSafeActions(actions: readonly SelectableListAction[], filtered: boolean): void {
	if (!filtered) return;
	for (const action of actions) assertFilterSafeKey(action.key, action.id);
}

function assertFilterSafeKey(key: KeyId, label: string): void {
	if (isFilterSafeKey(key)) return;
	throw new Error(`Filtered list action ${label} uses text key ${key}. Use ctrl, alt, super, or a non-printable key.`);
}

function isFilterSafeKey(key: KeyId): boolean {
	if (key.includes("ctrl+") || key.includes("alt+") || key.includes("super+")) return true;
	const base = key.split("+").at(-1) ?? key;
	return NON_PRINTABLE_KEYS.has(base) && base !== "space";
}
