import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Key, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { rawHint, type ToolKeyHint } from "./key-hints.ts";

export interface TabItem {
	id: string;
	label: string;
	count?: number;
	body: Component;
	getKeyHints?: () => readonly ToolKeyHint[];
}

export class Tabs implements Component {
	private readonly theme: Theme;
	private tabs: readonly TabItem[];
	private activeId: string;

	constructor(theme: Theme, tabs: readonly TabItem[], activeId: string) {
		this.theme = theme;
		this.tabs = tabs;
		this.activeId = tabs.some((tab) => tab.id === activeId) ? activeId : (tabs[0]?.id ?? "");
	}

	getActiveId(): string {
		return this.activeId;
	}

	setActiveId(id: string): void {
		if (this.tabs.some((tab) => tab.id === id)) this.activeId = id;
	}

	setTabs(tabs: readonly TabItem[]): void {
		this.tabs = tabs;
		if (!tabs.some((tab) => tab.id === this.activeId)) this.activeId = tabs[0]?.id ?? "";
	}

	handleKey(data: string): boolean {
		const direction =
			matchesKey(data, Key.tab) || matchesKey(data, Key.right)
				? 1
				: matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)
					? -1
					: 0;
		if (direction === 0) return false;
		if (this.tabs.length === 0) return true;
		const currentIndex = this.tabs.findIndex((tab) => tab.id === this.activeId);
		const start = currentIndex >= 0 ? currentIndex : 0;
		const next = this.tabs[(start + direction + this.tabs.length) % this.tabs.length];
		if (next) this.activeId = next.id;
		return true;
	}

	handleInput(data: string): void {
		if (this.handleKey(data)) return;
		this.activeBody()?.handleInput?.(data);
	}

	getKeyHints(): ToolKeyHint[] {
		return [rawHint("Tab/←/→", "switch tab"), ...(this.activeTab()?.getKeyHints?.() ?? [])];
	}

	render(width: number): string[] {
		const renderWidth = Math.max(1, width);
		const parts = this.tabs.map((tab) => {
			const count = tab.count === undefined ? "" : ` ${this.theme.fg("dim", String(tab.count))}`;
			const text = ` ${tab.label}${count} `;
			return tab.id === this.activeId
				? this.theme.bg("selectedBg", this.theme.fg("text", this.theme.bold(text)))
				: this.theme.fg("muted", text);
		});
		const lines = wrapTextWithAnsi(parts.join(" "), renderWidth).map((line) =>
			truncateToWidth(line, renderWidth, ""),
		);
		const activeBody = this.activeBody()?.render(renderWidth) ?? [];
		if (activeBody.length > 0) lines.push("");
		lines.push(...activeBody.map((line) => truncateToWidth(line, renderWidth, "")));
		return lines;
	}

	invalidate(): void {
		for (const tab of this.tabs) tab.body.invalidate();
	}

	private activeBody(): Component | undefined {
		return this.activeTab()?.body;
	}

	private activeTab(): TabItem | undefined {
		return this.tabs.find((tab) => tab.id === this.activeId);
	}
}
