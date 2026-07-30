import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type KeybindingsManager,
	truncateToWidth,
	type TUI,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { bindingHint, Tabs, ToolPanel } from "@shanepadgett/tau-tui";
import type { CarryMemory, DeferredFile, MemoryItem } from "./state.ts";

export type SessionMemoryTab = "tasks" | "memories" | "files";

export interface SessionMemoryWidgetView {
	goal: string;
	objective: string;
	checkpoint: number;
	activeTokens: number;
	updatedAt: number | undefined;
	tasks: readonly string[];
	carry: readonly CarryMemory[];
	durable: readonly MemoryItem[];
	readFiles: readonly string[];
	outlineFiles: readonly string[];
	deferFiles: readonly DeferredFile[];
}

export interface SessionMemoryWidgetOptions {
	view: SessionMemoryWidgetView;
	selectedTab: SessionMemoryTab;
	onClose: () => void;
}

export function createSessionMemoryWidget(
	tui: TUI,
	theme: Theme,
	keys: KeybindingsManager,
	options: SessionMemoryWidgetOptions,
): Component {
	return new SessionMemoryWidget(tui, theme, keys, options);
}

class SessionMemoryWidget implements Component {
	private readonly tui: TUI;
	private readonly keys: KeybindingsManager;
	private readonly tabs: Tabs;
	private readonly panel: ToolPanel;
	private readonly onClose: () => void;

	constructor(tui: TUI, theme: Theme, keys: KeybindingsManager, options: SessionMemoryWidgetOptions) {
		this.tui = tui;
		this.keys = keys;
		this.onClose = options.onClose;
		const view = options.view;
		this.tabs = new Tabs(
			theme,
			[
				{
					id: "tasks",
					label: "Tasks",
					count: view.tasks.length,
					body: new WrappedLines(() =>
						view.tasks.map((task, index) =>
							index === 0
								? `${theme.fg("accent", "●")} ${theme.fg("text", theme.bold(task))}`
								: `${theme.fg("muted", "○")} ${theme.fg("muted", task)}`,
						),
					),
				},
				{
					id: "memories",
					label: "Memories",
					count: view.carry.length + view.durable.length,
					body: new WrappedLines(() => [
						theme.fg("warning", theme.bold(`Carry  ${view.carry.length}`)),
						...view.carry.map((item) => `${theme.fg("warning", "◆")} ${item.text}`),
						"",
						theme.fg("success", theme.bold(`Durable  ${view.durable.length}`)),
						...view.durable.map((item) => `${theme.fg("success", "●")} ${item.text}`),
					]),
				},
				{
					id: "files",
					label: "Files",
					count: view.readFiles.length + view.outlineFiles.length + view.deferFiles.length,
					body: new WrappedLines(() => [
						theme.fg("accent", theme.bold(`Read  ${view.readFiles.length}`)),
						...view.readFiles.map((path) => `${theme.fg("accent", "▸")} ${path}`),
						"",
						theme.fg("muted", theme.bold(`Outline  ${view.outlineFiles.length}`)),
						...view.outlineFiles.map((path) => `${theme.fg("muted", "◇")} ${path}`),
						"",
						theme.fg("dim", theme.bold(`Deferred  ${view.deferFiles.length}`)),
						...view.deferFiles.flatMap((file) => [
							theme.fg("dim", `◌ ${file.path}`),
							theme.fg("dim", `  when ${file.relevantWhen}`),
						]),
					]),
				},
			],
			options.selectedTab,
		);
		this.panel = new ToolPanel(theme, {
			title: "Session memory",
			secondary: `checkpoint ${view.checkpoint} · ${formatTokens(view.activeTokens)} active tokens · ${
				view.updatedAt === undefined ? "not saved yet" : `updated ${formatUpdated(view.updatedAt)}`
			}`,
			header: new WrappedLines(() => [
				`${theme.fg("muted", theme.bold("GOAL"))}  ${view.goal}`,
				`${theme.fg("accent", theme.bold("NOW"))}   ${view.objective}`,
			]),
			body: this.tabs,
			footer: {
				kind: "hints",
				hints: [...this.tabs.getKeyHints(), bindingHint("tui.select.cancel", "close")],
			},
			border: "box",
		});
	}

	handleInput(data: string): void {
		if (this.keys.matches(data, "tui.select.cancel")) {
			this.onClose();
			return;
		}
		const activeTab = this.tabs.getActiveId();
		this.tabs.handleInput(data);
		if (activeTab !== this.tabs.getActiveId()) this.tui.requestRender();
	}

	render(width: number): string[] {
		return this.panel.render(width);
	}

	invalidate(): void {
		this.panel.invalidate();
	}
}

class WrappedLines implements Component {
	private readonly lines: () => readonly string[];

	constructor(lines: () => readonly string[]) {
		this.lines = lines;
	}

	render(width: number): string[] {
		const renderWidth = Math.max(1, width);
		return this.lines().flatMap((line) =>
			line.length === 0
				? [""]
				: wrapTextWithAnsi(line, renderWidth).map((part) => truncateToWidth(part, renderWidth, "")),
		);
	}

	invalidate(): void {}
}

function formatTokens(tokens: number): string {
	return tokens < 1_000 ? String(tokens) : `${Math.round(tokens / 1_000)}k`;
}

function formatUpdated(timestamp: number): string {
	const elapsed = Math.max(0, Date.now() - timestamp);
	if (elapsed < 60_000) return "now";
	if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`;
	if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h ago`;
	return `${Math.floor(elapsed / 86_400_000)}d ago`;
}
