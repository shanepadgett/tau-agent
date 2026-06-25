import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type Focusable,
	fuzzyFilter,
	Input,
	Key,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

export interface TabbedMultiSelectItem {
	id: string;
	label: string;
	description?: string;
}

export interface TabbedMultiSelectTab {
	id: string;
	label: string;
	items: readonly TabbedMultiSelectItem[];
}

export interface TabbedMultiSelectSelection {
	tabId: string;
	itemId: string;
}

export class TabbedMultiSelect implements Component, Focusable {
	private readonly title: string;
	private readonly tabs: readonly TabbedMultiSelectTab[];
	private readonly theme: Theme;
	private readonly done: (result: TabbedMultiSelectSelection[] | undefined) => void;
	private readonly filterInput = new Input();
	private activeTabIndex = 0;
	private itemIndex = 0;
	private filterMode = false;
	private cachedWidth?: number;
	private cachedLines?: string[];
	private readonly selected = new Set<string>();
	private _focused = false;

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.filterInput.focused = value && this.filterMode;
	}

	constructor(
		title: string,
		tabs: readonly TabbedMultiSelectTab[],
		theme: Theme,
		done: (result: TabbedMultiSelectSelection[] | undefined) => void,
	) {
		this.title = title;
		this.tabs = tabs;
		this.theme = theme;
		this.done = done;
		this.filterInput.onSubmit = () => {
			this.setFilterMode(false);
		};
		this.filterInput.onEscape = () => {
			if (this.filterInput.getValue()) this.filterInput.setValue("");
			else this.setFilterMode(false);
			this.itemIndex = 0;
			this.invalidate();
		};
	}

	handleInput(data: string): void {
		if (this.filterMode) {
			if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
				this.handleListInput(data);
				return;
			}

			if (data === " ") {
				this.toggleCurrentItem();
				return;
			}

			const previousFilter = this.filterInput.getValue();
			this.filterInput.handleInput(data);
			if (this.filterInput.getValue() !== previousFilter) this.itemIndex = 0;
			this.clampItemIndex();
			this.invalidate();
			return;
		}

		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
			this.done(undefined);
			return;
		}

		if (matchesKey(data, Key.enter)) {
			this.done(this.getSelections());
			return;
		}

		if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
			this.moveTab(1);
			return;
		}

		if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
			this.moveTab(-1);
			return;
		}

		if (data === "f") {
			this.setFilterMode(true);
			return;
		}

		this.handleListInput(data);
	}

	private handleListInput(data: string): void {
		const tab = this.currentTab();
		if (!tab) return;
		const items = this.currentItems();

		if (matchesKey(data, Key.up)) {
			this.itemIndex = items.length === 0 ? 0 : (this.itemIndex - 1 + items.length) % items.length;
			this.invalidate();
			return;
		}

		if (matchesKey(data, Key.down)) {
			this.itemIndex = items.length === 0 ? 0 : (this.itemIndex + 1) % items.length;
			this.invalidate();
			return;
		}

		if (data === " ") {
			this.toggleCurrentItem();
		}
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

		const lines: string[] = [];
		const renderWidth = Math.max(1, width);

		lines.push(this.theme.fg("border", "─".repeat(renderWidth)));
		lines.push(
			truncateToWidth(
				` ${this.theme.bold(this.title)} ${this.theme.fg("dim", `(${this.selected.size} selected)`)}`,
				renderWidth,
				"",
			),
		);
		lines.push("");
		lines.push(...this.renderTabs(renderWidth));
		lines.push("");
		if (this.filterMode) {
			lines.push(...this.filterInput.render(renderWidth));
			lines.push("");
		}
		lines.push(...this.renderItems(renderWidth));
		lines.push("");
		lines.push(
			truncateToWidth(
				` ${this.theme.fg("dim", this.filterMode ? "↑↓ move · Space toggle · Enter close filter · Esc clear/close filter" : "↑↓ move · Space toggle · f filter · ←/→ Tab switch tabs · Enter submit · Esc cancel")}`,
				renderWidth,
				"",
			),
		);
		lines.push(this.theme.fg("border", "─".repeat(renderWidth)));

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	private renderTabs(width: number): string[] {
		const parts = this.tabs.map((tab, index) => {
			const text = ` ${tab.label} `;
			return index === this.activeTabIndex
				? this.theme.bg("selectedBg", this.theme.fg("text", text))
				: this.theme.fg("muted", text);
		});
		return wrapTextWithAnsi(` ${parts.join(" ")}`, width);
	}

	private renderItems(width: number): string[] {
		const tab = this.currentTab();
		if (!tab) return [` ${this.theme.fg("warning", "No tabs")}`];
		const items = this.currentItems();
		if (tab.items.length === 0) return [` ${this.theme.fg("dim", "No items")}`];
		if (items.length === 0) return [` ${this.theme.fg("dim", "No matching items")}`];

		const lines: string[] = [];
		const maxVisible = 12;
		const start = Math.max(0, Math.min(this.itemIndex - Math.floor(maxVisible / 2), items.length - maxVisible));
		const end = Math.min(items.length, start + maxVisible);

		for (let i = start; i < end; i++) {
			const item = items[i]!;
			const isActive = i === this.itemIndex;
			const checked = this.selected.has(selectionKey(tab.id, item.id));
			const prefix = isActive ? this.theme.fg("accent", "> ") : "  ";
			const box = checked ? this.theme.fg("success", "[x]") : this.theme.fg("dim", "[ ]");
			const label = isActive ? this.theme.bold(item.label) : item.label;
			lines.push(truncateToWidth(`${prefix}${box} ${label}`, width, ""));

			if (item.description && isActive) {
				lines.push(...wrapIndented(this.theme.fg("muted", item.description), width, "    "));
			}
		}

		if (start > 0 || end < items.length) {
			lines.push(this.theme.fg("dim", `  (${this.itemIndex + 1}/${items.length})`));
		}

		return lines;
	}

	private moveTab(direction: 1 | -1): void {
		if (this.tabs.length === 0) return;
		this.activeTabIndex = (this.activeTabIndex + direction + this.tabs.length) % this.tabs.length;
		this.itemIndex = 0;
		this.invalidate();
	}

	private setFilterMode(enabled: boolean): void {
		this.filterMode = enabled;
		this.filterInput.focused = this._focused && enabled;
		this.clampItemIndex();
		this.invalidate();
	}

	private toggleCurrentItem(): void {
		const tab = this.currentTab();
		const item = this.currentItems()[this.itemIndex];
		if (!tab || !item) return;
		const key = selectionKey(tab.id, item.id);
		if (this.selected.has(key)) this.selected.delete(key);
		else this.selected.add(key);
		this.invalidate();
	}

	private currentItems(): readonly TabbedMultiSelectItem[] {
		const tab = this.currentTab();
		if (!tab) return [];
		const filter = this.filterInput.getValue();
		return filter
			? fuzzyFilter([...tab.items], filter, (item) => `${item.label} ${item.description ?? ""}`)
			: tab.items;
	}

	private clampItemIndex(): void {
		this.itemIndex = Math.min(this.itemIndex, Math.max(0, this.currentItems().length - 1));
	}

	private currentTab(): TabbedMultiSelectTab | undefined {
		return this.tabs[this.activeTabIndex];
	}

	private getSelections(): TabbedMultiSelectSelection[] {
		const selections: TabbedMultiSelectSelection[] = [];
		for (const tab of this.tabs) {
			for (const item of tab.items) {
				if (this.selected.has(selectionKey(tab.id, item.id))) selections.push({ tabId: tab.id, itemId: item.id });
			}
		}
		return selections;
	}
}

function selectionKey(tabId: string, itemId: string): string {
	return `${tabId}\u0000${itemId}`;
}

function wrapIndented(text: string, width: number, indent: string): string[] {
	const contentWidth = Math.max(1, width - visibleWidth(indent));
	return wrapTextWithAnsi(text, contentWidth).map((line) => `${indent}${line}`);
}
