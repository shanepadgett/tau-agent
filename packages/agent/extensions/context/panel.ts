import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, getKeybindings, Key, matchesKey, truncateToWidth, type TUI } from "@earendil-works/pi-tui";
import { bindingHint, rawHint, SelectableList, Tabs, ToolPanel, type ToolPanelConfig } from "@shanepadgett/tau-tui";
import type { ContextEntry, ContextOperation } from "./definitions.ts";

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

export type ProposalReviewDecision =
	| { kind: "approve"; operations: ContextOperation[] }
	| { kind: "feedback"; scope: "batch"; selectedIds: string[] }
	| { kind: "feedback"; scope: "operation"; operationId: string; selectedIds: string[] }
	| { kind: "rejected" };

export class ProposalPanel implements Component {
	private readonly list: SelectableList<ContextOperation>;
	private readonly panel: ToolPanel;
	private readonly done: (result: ProposalReviewDecision) => void;
	private selected: readonly ContextOperation[] = [];
	private current: ContextOperation;
	constructor(
		tui: TUI,
		theme: Theme,
		proposals: readonly ContextOperation[],
		done: (result: ProposalReviewDecision) => void,
	) {
		const first = proposals[0];
		if (!first) throw new Error("Proposal panel requires at least one operation");
		this.done = done;
		this.current = first;
		const items = [...proposals];
		this.list = new SelectableList(theme, {
			items,
			emptyMessage: "No proposals.",
			selection: { kind: "multi", primaryLabel: "apply selected" },
			actions: [],
			cancelLabel: "cancel",
			maxVisible: 12,
			renderItem: (item, _state, width) => [
				truncateToWidth(
					`${theme.fg("accent", item.kind)} · ${item.tab}/${item.concept}/${item.entry}  ${theme.fg("dim", item.reason)}`,
					width,
					"…",
				),
			],
			onResult: (result) =>
				done(
					result.kind === "primary" && result.items.length > 0
						? { kind: "approve", operations: [...result.items] }
						: { kind: "rejected" },
				),
			onSelectionChange: (selected) => {
				this.selected = selected;
				tui.requestRender();
			},
		});
		this.list.setSelectedIds(items.map((item) => item.id));
		this.selected = items;
		this.panel = new ToolPanel(theme, {
			title: "Maintain contexts",
			secondary: "Review proposed operations",
			body: {
				render: (width) => [
					...this.list.render(width),
					"",
					...operationPaths(this.current).map((path) =>
						truncateToWidth(theme.fg("muted", `• ${path}`), width, "…"),
					),
				],
				invalidate: () => this.list.invalidate(),
			},
			footer: {
				kind: "hints",
				hints: [
					...this.list.getKeyHints(),
					rawHint("ctrl+b", "batch feedback"),
					rawHint("ctrl+i", "item feedback"),
				],
			},
		});
	}
	handleInput(data: string): void {
		if (!this.list.isFilterFocused()) {
			const selectedIds = this.selected.map((item) => item.id);
			if (matchesKey(data, Key.ctrl("b"))) {
				this.done({ kind: "feedback", scope: "batch", selectedIds });
				return;
			}
			if (matchesKey(data, Key.ctrl("i"))) {
				const current = this.list.getCurrentItem();
				if (current) this.done({ kind: "feedback", scope: "operation", operationId: current.id, selectedIds });
				return;
			}
		}
		this.list.handleInput(data);
		this.current = this.list.getCurrentItem() ?? this.current;
	}
	render(width: number): string[] {
		return this.panel.render(width);
	}
	invalidate(): void {
		this.panel.invalidate();
	}
}

function operationPaths(operation: ContextOperation): string[] {
	return operation.kind === "replace-file" ? [`${operation.from} → ${operation.to}`] : operation.files;
}
