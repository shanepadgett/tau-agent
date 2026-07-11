import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, getKeybindings, type TUI, truncateToWidth } from "@earendil-works/pi-tui";
import { bindingHint, SelectableList, Tabs, ToolPanel, type ToolPanelConfig } from "@shanepadgett/tau-tui";

interface PreviewContext {
	id: string;
	tab: string;
	concept: string;
	name: string;
	files: string[];
}

const ENTRIES: readonly PreviewContext[] = [
	{
		id: "extensions/context/selection",
		tab: "extensions",
		concept: "Context",
		name: "selection",
		files: [
			"packages/agent/extensions/context/index.ts",
			"packages/agent/extensions/context/panel.ts",
			"packages/agent/extensions/context/definitions.ts",
		],
	},
	{
		id: "extensions/context/research",
		tab: "extensions",
		concept: "Context",
		name: "research",
		files: [
			"packages/agent/extensions/subagent/agents/context-research.md",
			"packages/agent/extensions/subagent/agents.ts",
			"packages/agent/extensions/subagent/run.ts",
		],
	},
	{
		id: "docs/tau/external-integration",
		tab: "docs",
		concept: "Tau",
		name: "external-integration",
		files: ["packages/agent/docs/extending-tau-agent.md", "packages/agent/shared/events.ts"],
	},
];

export function createContextPreviewOverlay(
	tui: TUI,
	theme: Theme,
	done: (result: readonly PreviewContext[] | undefined) => void,
): Component {
	return new ContextOverlay(tui, theme, done);
}

class ContextOverlay implements Component {
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly tabs: Tabs;
	private readonly panel: ToolPanel;
	private readonly config: ToolPanelConfig;
	private readonly lists = new Map<string, SelectableList<PreviewContext>>();
	private readonly selected = new Map<string, readonly PreviewContext[]>();
	private readonly done: (result: readonly PreviewContext[] | undefined) => void;
	private current = ENTRIES[0];

	constructor(tui: TUI, theme: Theme, done: (result: readonly PreviewContext[] | undefined) => void) {
		this.tui = tui;
		this.theme = theme;
		this.done = done;
		const tabNames = [...new Set(ENTRIES.map((entry) => entry.tab))];
		this.tabs = new Tabs(
			theme,
			tabNames.map((tab) => {
				const items = ENTRIES.filter((entry) => entry.tab === tab);
				const list = new SelectableList(theme, {
					items,
					emptyMessage: "No context entries.",
					selection: { kind: "multi" },
					filter: { searchText: (entry) => `${entry.concept} ${entry.name}` },
					actions: [],
					maxVisible: 4,
					renderItem: (entry, state, width) => [
						truncateToWidth(
							`${state.active ? theme.bold(entry.concept) : entry.concept} · ${entry.name}`,
							width,
							"…",
						),
					],
					onResult: () => {},
					onSelectionChange: (entries) => {
						this.selected.set(tab, entries);
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
		const list = this.lists.get(this.tabs.getActiveId());
		if (!list?.isFilterFocused()) {
			const keys = getKeybindings();
			if (keys.matches(data, "tui.select.confirm")) {
				this.done([...this.selected.values()].flatMap((entries) => [...entries]));
				return;
			}
			if (keys.matches(data, "tui.select.cancel")) {
				this.done(undefined);
				return;
			}
		}
		this.tabs.handleInput(data);
		this.current = this.lists.get(this.tabs.getActiveId())?.getCurrentItem() ?? this.current;
		this.sync();
	}

	render(width: number): string[] {
		return this.panel.render(width);
	}

	invalidate(): void {
		this.panel.invalidate();
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
		return `${[...this.selected.values()].reduce((count, entries) => count + entries.length, 0)} selected`;
	}

	private hints() {
		const list = this.lists.get(this.tabs.getActiveId());
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
