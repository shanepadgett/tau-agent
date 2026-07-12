import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, getKeybindings, Key, matchesKey, truncateToWidth, type TUI } from "@earendil-works/pi-tui";
import { bindingHint, rawHint, SelectableList, Tabs, ToolPanel, type ToolPanelConfig } from "@shanepadgett/tau-tui";
import type { ContextEntry } from "./definitions.ts";

type SelectableEntry = ContextEntry & { id: string };

export class ContextPanel implements Component {
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly tabs: Tabs;
	private readonly panel: ToolPanel;
	private readonly config: ToolPanelConfig;
	private readonly lists = new Map<string, SelectableList<SelectableEntry>>();
	private readonly selected = new Map<string, readonly SelectableEntry[]>();
	private readonly done: (result: ContextEntry[] | undefined) => void;
	private current: ContextEntry;
	private fileOffset = 0;

	constructor(
		tui: TUI,
		theme: Theme,
		entries: readonly ContextEntry[],
		done: (result: ContextEntry[] | undefined) => void,
	) {
		const firstEntry = entries[0];
		if (!firstEntry) throw new Error("Context panel requires at least one entry");
		this.tui = tui;
		this.theme = theme;
		this.done = done;
		this.current = firstEntry;
		const tabNames = [...new Set(entries.map((entry) => entry.tab))].sort();
		this.tabs = new Tabs(
			theme,
			tabNames.map((tab) => {
				const items = entries.filter((entry) => entry.tab === tab);
				const list = new SelectableList(theme, {
					items,
					emptyMessage: "No context entries.",
					selection: { kind: "multi" },
					filter: { searchText: (item) => `${item.conceptName} ${item.name} ${item.description}` },
					actions: [],
					maxVisible: 10,
					renderItem: (item, state, width) => [
						truncateToWidth(
							`${state.active ? theme.bold(item.conceptName) : item.conceptName} · ${item.name}  ${theme.fg("dim", item.description)}`,
							width,
							"…",
						),
					],
					onResult: () => {},
					onSelectionChange: (value) => {
						this.selected.set(tab, value);
						this.sync();
					},
				});
				this.lists.set(tab, list);
				return { id: tab, label: tab, count: items.length, body: list, getKeyHints: () => list.getKeyHints() };
			}),
			tabNames[0] ?? "",
		);
		this.config = {
			title: "Project context",
			secondary: this.secondary(),
			body: this.body(),
			footer: { kind: "hints", hints: this.hints() },
			border: "box",
		};
		this.panel = new ToolPanel(theme, this.config);
	}

	handleInput(data: string): void {
		const list = this.activeList();
		if (!list?.isFilterFocused()) {
			const keys = getKeybindings();
			const pageSize = this.filePageSize();
			if (this.current.files.length > pageSize && matchesKey(data, Key.alt("up"))) {
				this.fileOffset = Math.max(0, this.fileOffset - pageSize);
				this.sync();
				return;
			}
			if (this.current.files.length > pageSize && matchesKey(data, Key.alt("down"))) {
				this.fileOffset = Math.min(this.current.files.length - pageSize, this.fileOffset + pageSize);
				this.sync();
				return;
			}
			if (matchesKey(data, Key.ctrl("c"))) {
				for (const [tab, tabList] of this.lists) {
					tabList.setSelectedIds([]);
					this.selected.set(tab, []);
				}
				this.sync();
				return;
			}
			if (keys.matches(data, "tui.select.confirm")) {
				this.done([...this.selected.values()].flatMap((items) => [...items]));
				return;
			}
			if (keys.matches(data, "tui.select.cancel")) {
				this.done(undefined);
				return;
			}
		}
		this.tabs.handleInput(data);
		const current = this.activeList()?.getCurrentItem() ?? this.current;
		if (current.id !== this.current.id) this.fileOffset = 0;
		this.current = current;
		this.sync();
	}

	render(width: number): string[] {
		return this.panel.render(width);
	}
	invalidate(): void {
		this.panel.invalidate();
	}

	private activeList(): SelectableList<SelectableEntry> | undefined {
		return this.lists.get(this.tabs.getActiveId());
	}
	private body(): Component {
		return {
			render: (width) => {
				const tabs = this.tabs.render(width);
				const pageSize = this.filePageSize(tabs.length);
				const maxOffset = Math.max(0, this.current.files.length - pageSize);
				this.fileOffset = Math.min(this.fileOffset, maxOffset);
				const files = this.current.files.slice(this.fileOffset, this.fileOffset + pageSize);
				const range =
					this.current.files.length > pageSize
						? this.theme.fg(
								"dim",
								`${this.fileOffset + 1}-${this.fileOffset + files.length} of ${this.current.files.length} files`,
							)
						: undefined;
				return [
					...tabs,
					"",
					...(range ? [truncateToWidth(range, width, "…")] : []),
					...files.map((file) => truncateToWidth(this.theme.fg("muted", `• ${file}`), width, "…")),
				];
			},
			invalidate: () => this.tabs.invalidate(),
		};
	}
	private filePageSize(tabLines = this.tabs.render(this.tui.terminal.columns).length): number {
		const overlayHeight = Math.floor(this.tui.terminal.rows * 0.8);
		const available = Math.max(1, overlayHeight - tabLines - 7);
		const pageSize = Math.min(8, available);
		return this.current.files.length > pageSize ? Math.max(1, pageSize - 1) : pageSize;
	}
	private secondary(): string {
		return `${[...this.selected.values()].reduce((sum, items) => sum + items.length, 0)} selected`;
	}
	private hints() {
		const list = this.activeList();
		return list?.isFilterFocused()
			? list.getKeyHints()
			: [
					...this.tabs.getKeyHints(),
					...(this.current.files.length > this.filePageSize() ? [rawHint("option+↑/↓", "scroll files")] : []),
					rawHint("ctrl+c", "clear all"),
					bindingHint("tui.select.confirm", "inject"),
					bindingHint("tui.select.cancel", "cancel"),
				];
	}
	private sync(): void {
		this.config.secondary = this.secondary();
		this.config.footer = { kind: "hints", hints: this.hints() };
		this.tui.requestRender();
	}
}
