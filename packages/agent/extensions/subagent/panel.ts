import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, getKeybindings, Key, matchesKey, truncateToWidth, type TUI } from "@earendil-works/pi-tui";
import {
	rawHint,
	SelectableList,
	type SelectableListResult,
	ToolPanel,
	type ToolPanelConfig,
} from "@shanepadgett/tau-tui";

export interface AgentPanelItem {
	id: string;
	disabled: boolean;
	configured: boolean;
}

export function createAgentsPanel(
	tui: TUI,
	theme: Theme,
	initial: readonly AgentPanelItem[],
	onApply: (disabled: readonly string[]) => void,
	done: () => void,
): Component {
	return new AgentsPanel(tui, theme, initial, onApply, done);
}

class AgentsPanel implements Component {
	private readonly tui: TUI;
	private readonly onApply: (disabled: readonly string[]) => void;
	private readonly done: () => void;
	private readonly list: SelectableList<AgentPanelItem>;
	private readonly panelConfig: ToolPanelConfig;
	private readonly panel: ToolPanel;
	private items: readonly AgentPanelItem[];
	private closed = false;

	constructor(
		tui: TUI,
		theme: Theme,
		initial: readonly AgentPanelItem[],
		onApply: (disabled: readonly string[]) => void,
		done: () => void,
	) {
		this.tui = tui;
		this.items = initial;
		this.onApply = onApply;
		this.done = done;
		this.list = new SelectableList(theme, {
			items: initial,
			emptyMessage: "No valid subagents found.",
			selection: { kind: "single", primaryLabel: "apply" },
			actions: [],
			cancelLabel: "close",
			maxVisible: 10,
			renderItem: (item, state, width) => {
				const label = state.active ? theme.bold(item.id) : item.id;
				const status = item.configured
					? theme.fg("muted", "disabled by Tau settings")
					: item.disabled
						? theme.fg("warning", "disabled")
						: theme.fg("success", "enabled");
				return [truncateToWidth(`${label}  ${status}`, width, "…")];
			},
			onResult: (result) => this.handleResult(result),
		});
		this.panelConfig = {
			title: "Subagents",
			secondary: "Changes apply to this session.",
			body: this.list,
			footer: { kind: "hints", hints: this.hints() },
			border: "box",
		};
		this.panel = new ToolPanel(theme, this.panelConfig);
	}

	render(width: number): string[] {
		return this.panel.render(width);
	}

	invalidate(): void {
		this.panel.invalidate();
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.space) || data === " ") {
			const current = this.list.getCurrentItem();
			if (!current || current.configured) return;
			this.items = this.items.map((item) => (item.id === current.id ? { ...item, disabled: !item.disabled } : item));
			this.list.setItems(this.items, current.id);
			this.syncPanel();
			return;
		}
		if (getKeybindings().matches(data, "tui.select.confirm")) {
			this.onApply(this.items.filter((item) => item.disabled && !item.configured).map((item) => item.id));
			this.closed = true;
			this.done();
			return;
		}
		this.list.handleInput(data);
		if (!this.closed) this.syncPanel();
	}

	private handleResult(result: SelectableListResult<AgentPanelItem>): void {
		if (result.kind === "cancel") {
			this.closed = true;
			this.done();
			return;
		}
	}

	private syncPanel(): void {
		this.panelConfig.footer = { kind: "hints", hints: this.hints() };
		this.tui.requestRender();
	}

	private hints() {
		const hints = this.list.getKeyHints();
		const current = this.list.getCurrentItem();
		if (current && !current.configured) {
			hints.splice(1, 0, rawHint("Space", "toggle"));
		}
		return hints;
	}
}
