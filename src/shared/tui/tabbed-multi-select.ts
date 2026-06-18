import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
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

export class TabbedMultiSelect implements Component {
	private readonly title: string;
	private readonly tabs: readonly TabbedMultiSelectTab[];
	private readonly theme: Theme;
	private readonly done: (result: TabbedMultiSelectSelection[] | undefined) => void;
	private activeTabIndex = 0;
	private itemIndex = 0;
	private cachedWidth?: number;
	private cachedLines?: string[];
	private readonly selected = new Set<string>();

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
	}

	handleInput(data: string): void {
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

		const tab = this.currentTab();
		if (!tab) return;

		if (matchesKey(data, Key.up)) {
			this.itemIndex = tab.items.length === 0 ? 0 : (this.itemIndex - 1 + tab.items.length) % tab.items.length;
			this.invalidate();
			return;
		}

		if (matchesKey(data, Key.down)) {
			this.itemIndex = tab.items.length === 0 ? 0 : (this.itemIndex + 1) % tab.items.length;
			this.invalidate();
			return;
		}

		if (data === " ") {
			const item = tab.items[this.itemIndex];
			if (!item) return;
			const key = selectionKey(tab.id, item.id);
			if (this.selected.has(key)) this.selected.delete(key);
			else this.selected.add(key);
			this.invalidate();
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
		lines.push(...this.renderItems(renderWidth));
		lines.push("");
		lines.push(
			truncateToWidth(
				` ${this.theme.fg("dim", "↑↓ move · Space toggle · ←/→ Tab switch tabs · Enter submit · Esc cancel")}`,
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
		if (tab.items.length === 0) return [` ${this.theme.fg("dim", "No items")}`];

		const lines: string[] = [];
		const maxVisible = 12;
		const start = Math.max(0, Math.min(this.itemIndex - Math.floor(maxVisible / 2), tab.items.length - maxVisible));
		const end = Math.min(tab.items.length, start + maxVisible);

		for (let i = start; i < end; i++) {
			const item = tab.items[i]!;
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

		if (start > 0 || end < tab.items.length) {
			lines.push(this.theme.fg("dim", `  (${this.itemIndex + 1}/${tab.items.length})`));
		}

		return lines;
	}

	private moveTab(direction: 1 | -1): void {
		if (this.tabs.length === 0) return;
		this.activeTabIndex = (this.activeTabIndex + direction + this.tabs.length) % this.tabs.length;
		this.itemIndex = 0;
		this.invalidate();
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
