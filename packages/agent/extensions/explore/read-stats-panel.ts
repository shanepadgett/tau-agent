import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, type KeybindingsManager, truncateToWidth, type TUI } from "@earendil-works/pi-tui";
import { bindingHint, Tabs, ToolPanel, type ToolPanelConfig } from "@shanepadgett/tau-tui";
import type { ReadCacheMode } from "./read-cache.ts";

export interface ReadSavingsSnapshot {
	label: string;
	secondary: string;
	baselineTokens: number;
	returnedTokens: number;
	costSaved: number;
	unchangedCost: number;
	diffCost: number;
	counts: Record<ReadCacheMode, number>;
}

export function createReadStatsPanel(
	tui: TUI,
	theme: Theme,
	keybindings: KeybindingsManager,
	done: (result: unknown) => void,
	current: ReadSavingsSnapshot,
	whole: ReadSavingsSnapshot,
): Component {
	return new ReadStatsPanel(tui, theme, keybindings, done, current, whole);
}

class ReadStatsPanel implements Component {
	private readonly tui: TUI;
	private readonly keybindings: KeybindingsManager;
	private readonly done: (result: unknown) => void;
	private readonly snapshots: readonly [ReadSavingsSnapshot, ReadSavingsSnapshot];
	private readonly tabs: Tabs;
	private readonly config: ToolPanelConfig;
	private readonly panel: ToolPanel;

	constructor(
		tui: TUI,
		theme: Theme,
		keybindings: KeybindingsManager,
		done: (result: unknown) => void,
		current: ReadSavingsSnapshot,
		whole: ReadSavingsSnapshot,
	) {
		this.tui = tui;
		this.keybindings = keybindings;
		this.done = done;
		this.snapshots = [current, whole];
		this.tabs = new Tabs(
			theme,
			this.snapshots.map((snapshot) => ({
				id: snapshot.label,
				label: snapshot.label,
				body: new SavingsBody(theme, snapshot),
			})),
			current.label,
		);
		this.config = {
			title: "Read savings",
			secondary: current.secondary,
			body: this.tabs,
			footer: {
				kind: "hints",
				hints: [...this.tabs.getKeyHints(), bindingHint("tui.select.cancel", "close")],
			},
			border: "box",
		};
		this.panel = new ToolPanel(theme, this.config);
	}

	handleInput(data: string): void {
		if (this.keybindings.matches(data, "tui.select.cancel")) {
			this.done(undefined);
			return;
		}
		this.tabs.handleInput(data);
		const snapshot = this.snapshots.find((item) => item.label === this.tabs.getActiveId()) ?? this.snapshots[0];
		this.config.secondary = snapshot.secondary;
		this.tui.requestRender();
	}

	render(width: number): string[] {
		return this.panel.render(width);
	}

	invalidate(): void {
		this.panel.invalidate();
	}
}

class SavingsBody implements Component {
	private readonly theme: Theme;
	private readonly snapshot: ReadSavingsSnapshot;

	constructor(theme: Theme, snapshot: ReadSavingsSnapshot) {
		this.theme = theme;
		this.snapshot = snapshot;
	}

	render(width: number): string[] {
		const avoided = Math.max(0, this.snapshot.baselineTokens - this.snapshot.returnedTokens);
		const reduction = this.snapshot.baselineTokens > 0 ? avoided / this.snapshot.baselineTokens : 0;
		return [
			this.theme.bold("Tokens"),
			metricRow("Without cache", formatTokens(this.snapshot.baselineTokens), width),
			metricRow("With cache", formatTokens(this.snapshot.returnedTokens), width),
			metricRow(
				"Saved",
				this.theme.fg("success", `${formatTokens(avoided)} tokens (${Math.round(reduction * 100)}%)`),
				width,
			),
			"",
			this.theme.bold("Cost saved"),
			metricRow("Total", this.theme.fg("success", this.theme.bold(formatCost(this.snapshot.costSaved))), width),
			metricRow("Unchanged", formatCost(this.snapshot.unchangedCost), width),
			metricRow("Changes only", formatCost(this.snapshot.diffCost), width),
			"",
			this.theme.bold("Read results"),
			countRow("Baseline", this.snapshot.counts.baseline, "Unchanged", this.snapshot.counts.unchanged, width),
			countRow("Changes", this.snapshot.counts.diff, "Recovery", this.snapshot.counts.recovery, width),
			"",
			truncateToWidth(
				this.theme.fg("dim", "Estimates include repeated chat history and prompt caching."),
				width,
				"",
			),
		];
	}

	invalidate(): void {}
}

function formatTokens(value: number): string {
	if (value >= 1_000_000) return `~${(value / 1_000_000).toFixed(2)}M`;
	if (value >= 1_000) return `~${Math.round(value / 1_000)}k`;
	return `~${Math.max(0, Math.round(value))}`;
}

function formatCost(value: number): string {
	if (value > 0 && value < 0.01) return "<$0.01";
	return `~$${Math.max(0, value).toFixed(2)}`;
}

function metricRow(label: string, value: string, width: number): string {
	return truncateToWidth(`${label.padEnd(16)}${value}`, width, "");
}

function countRow(left: string, leftCount: number, right: string, rightCount: number, width: number): string {
	return truncateToWidth(
		`${left.padEnd(11)}${String(leftCount).padEnd(6)}${right.padEnd(11)}${rightCount}`,
		width,
		"",
	);
}
