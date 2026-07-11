import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, getKeybindings, Key, matchesKey, truncateToWidth, type TUI } from "@earendil-works/pi-tui";
import { bindingHint, rawHint, SelectableList, Tabs, ToolPanel, type ToolPanelConfig } from "@shanepadgett/tau-tui";
import type { ContextEntry, ContextProposal } from "./definitions.ts";

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
		this.current = this.activeList()?.getCurrentItem() ?? this.current;
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
			render: (width) => [
				...this.tabs.render(width),
				"",
				...this.current.files.map((file) => truncateToWidth(this.theme.fg("muted", `• ${file}`), width, "…")),
			],
			invalidate: () => this.tabs.invalidate(),
		};
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

type ProposalItem = ContextProposal & { id: string };

export class ProposalPanel implements Component {
	private readonly list: SelectableList<ProposalItem>;
	private readonly panel: ToolPanel;
	private readonly onCurrent: (proposal: ContextProposal | undefined) => void;
	constructor(
		tui: TUI,
		theme: Theme,
		proposals: readonly ContextProposal[],
		done: (result: ContextProposal[] | undefined) => void,
		onCurrent: (proposal: ContextProposal | undefined) => void,
	) {
		this.onCurrent = onCurrent;
		const items = proposals.map((proposal) => ({
			...proposal,
			id: `${proposal.tab}/${proposal.concept}/${proposal.entry}`,
		}));
		this.list = new SelectableList(theme, {
			items,
			emptyMessage: "No proposals.",
			selection: { kind: "multi", primaryLabel: "create selected" },
			actions: [],
			cancelLabel: "cancel",
			maxVisible: 12,
			renderItem: (item, _state, width) => [
				truncateToWidth(
					`${theme.fg("accent", item.tab)} · ${item.conceptName} · ${item.entry}  ${theme.fg("dim", item.description)}`,
					width,
					"…",
				),
			],
			onResult: (result) =>
				done(result.kind === "primary" ? result.items.map(({ id: _id, ...item }) => item) : undefined),
			onSelectionChange: () => tui.requestRender(),
		});
		this.list.setSelectedIds(items.map((item) => item.id));
		this.panel = new ToolPanel(theme, {
			title: "Create contexts",
			secondary: "Review researched entries",
			body: this.list,
			footer: { kind: "hints", hints: this.list.getKeyHints() },
		});
		this.onCurrent(this.list.getCurrentItem());
	}
	handleInput(data: string): void {
		this.list.handleInput(data);
		this.onCurrent(this.list.getCurrentItem());
	}
	render(width: number): string[] {
		return this.panel.render(width);
	}
	invalidate(): void {
		this.panel.invalidate();
	}
}
