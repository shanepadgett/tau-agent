import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	getKeybindings,
	truncateToWidth,
	type TUI,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { bindingHint, SelectableList, Tabs, ToolPanel, type ToolPanelConfig } from "@shanepadgett/tau-tui";
import type { ContextEntry, ContextProposal } from "./definitions.ts";

type SelectableEntry = ContextEntry & { id: string };

export class ContextPreview implements Component {
	private readonly theme: Theme;
	private entry: ContextEntry;

	constructor(theme: Theme, entry: ContextEntry) {
		this.theme = theme;
		this.entry = entry;
	}

	setEntry(entry: ContextEntry): void {
		this.entry = entry;
	}

	render(width: number): string[] {
		const renderWidth = Math.max(1, width);
		if (renderWidth < 5) return [];
		const innerWidth = renderWidth - 4;
		const title = " Context preview ";
		const breadcrumb = [
			this.theme.fg("muted", this.entry.tab),
			this.theme.fg("dim", " / "),
			this.theme.fg("muted", this.entry.concept),
			this.theme.fg("dim", " / "),
			this.theme.fg("accent", this.entry.name),
		].join("");
		const content = [
			...wrapTextWithAnsi(breadcrumb, innerWidth),
			"",
			...this.labeledText("Description: ", this.entry.description, innerWidth),
			"",
			this.theme.bold("Files:"),
			...this.entry.files.flatMap((file) => this.fileLines(file, innerWidth)),
		];
		const border = (text: string) => this.theme.fg("borderAccent", text);
		const background = (text: string) => this.theme.bg("customMessageBg", text);
		const topFill = Math.max(0, renderWidth - title.length - 2);
		const topLeft = Math.floor(topFill / 2);
		const topRight = topFill - topLeft;
		return [
			background(
				`${border(`╭${"─".repeat(topLeft)}`)}${this.theme.bold(title)}${border(`${"─".repeat(topRight)}╮`)}`,
			),
			...content.map((line) => {
				const rendered = truncateToWidth(line, innerWidth, "", true);
				return background(
					`${border("│")} ${rendered}${" ".repeat(Math.max(0, innerWidth - visibleWidth(rendered)))} ${border("│")}`,
				);
			}),
			background(border(`╰${"─".repeat(renderWidth - 2)}╯`)),
		];
	}

	invalidate(): void {}

	private labeledText(label: string, value: string, width: number): string[] {
		const lines = wrapTextWithAnsi(value, Math.max(1, width - label.length));
		return lines.map((line, index) => `${index === 0 ? this.theme.bold(label) : " ".repeat(label.length)}${line}`);
	}

	private fileLines(file: string, width: number): string[] {
		const lines = wrapTextWithAnsi(file, Math.max(1, width - 2));
		return lines.map((line, index) => `${index === 0 ? `${this.theme.fg("muted", "•")} ` : "  "}${line}`);
	}
}

export class ContextPanel implements Component {
	private readonly tui: TUI;
	private readonly tabs: Tabs;
	private readonly panel: ToolPanel;
	private readonly config: ToolPanelConfig;
	private readonly lists = new Map<string, SelectableList<SelectableEntry>>();
	private readonly selected = new Map<string, readonly SelectableEntry[]>();
	private readonly done: (result: ContextEntry[] | undefined) => void;
	private readonly onCurrent: (entry: ContextEntry | undefined) => void;

	constructor(
		tui: TUI,
		theme: Theme,
		entries: readonly ContextEntry[],
		done: (result: ContextEntry[] | undefined) => void,
		onCurrent: (entry: ContextEntry | undefined) => void,
	) {
		this.tui = tui;
		this.done = done;
		this.onCurrent = onCurrent;
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
			body: this.tabs,
			footer: { kind: "hints", hints: this.hints() },
		};
		this.panel = new ToolPanel(theme, this.config);
		this.publishCurrent();
	}

	handleInput(data: string): void {
		const list = this.activeList();
		if (!list?.isFilterFocused()) {
			const keys = getKeybindings();
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
		this.publishCurrent();
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
	private publishCurrent(): void {
		this.onCurrent(this.activeList()?.getCurrentItem());
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
