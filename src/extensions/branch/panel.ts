import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Key, type TUI, truncateToWidth } from "@earendil-works/pi-tui";
import { errorText } from "../../shared/text.ts";
import { bindingHint, rawHint } from "../../shared/tui/key-hints.ts";
import { SelectableList, type SelectableListResult } from "../../shared/tui/selectable-list.ts";
import { ToolPanel, type ToolPanelConfig, type ToolPanelFooter } from "../../shared/tui/tool-panel.ts";

const MAX_VISIBLE_BRANCHES = 10;

export type BranchChoice =
	| { id: string; kind: "local"; label: string; name: string; updatedAt: number }
	| { id: string; kind: "remote"; label: string; name: string; upstream: string; updatedAt: number };

export function showBranchPanel(
	ctx: ExtensionCommandContext,
	initial: readonly BranchChoice[],
	refresh: () => Promise<readonly BranchChoice[]>,
): Promise<BranchChoice | undefined> {
	return ctx.ui.custom<BranchChoice | undefined>(
		(tui, theme, _keybindings, done) =>
			new BranchPanel(
				tui,
				theme,
				initial,
				refresh,
				(error) => {
					ctx.ui.notify(`Branch fetch failed: ${errorText(error)}`, "error");
				},
				done,
			),
	);
}

class BranchPanel implements Component {
	private readonly tui: TUI;
	private readonly refresh: () => Promise<readonly BranchChoice[]>;
	private readonly onFetchError: (error: unknown) => void;
	private readonly done: (choice: BranchChoice | undefined) => void;
	private readonly list: SelectableList<BranchChoice>;
	private readonly panelConfig: ToolPanelConfig;
	private readonly panel: ToolPanel;
	private itemCount: number;
	private fetching = false;
	private closed = false;

	constructor(
		tui: TUI,
		theme: Theme,
		initial: readonly BranchChoice[],
		refresh: () => Promise<readonly BranchChoice[]>,
		onFetchError: (error: unknown) => void,
		done: (choice: BranchChoice | undefined) => void,
	) {
		this.tui = tui;
		this.refresh = refresh;
		this.onFetchError = onFetchError;
		this.done = done;
		this.itemCount = initial.length;
		this.list = new SelectableList(theme, {
			items: initial,
			emptyMessage: "No cached branches. Press ctrl+f to fetch.",
			selection: { kind: "single", primaryLabel: "switch" },
			actions: [{ id: "fetch", key: Key.ctrl("f"), hint: rawHint("ctrl+f", "fetch") }],
			cancelLabel: "cancel",
			maxVisible: MAX_VISIBLE_BRANCHES,
			renderItem: (item, state, width) => [
				truncateToWidth(theme.fg(state.active ? "accent" : "text", item.label), width, ""),
			],
			onResult: (result) => this.handleResult(result),
		});
		this.panelConfig = {
			title: "Branches",
			secondary: this.secondaryText(),
			body: this.list,
			footer: this.footer(),
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
		this.list.handleInput(data);
		if (!this.closed) this.syncPanel();
	}

	private handleResult(result: SelectableListResult<BranchChoice>): void {
		if (result.kind === "cancel") {
			this.closed = true;
			this.done(undefined);
			return;
		}
		if (this.fetching) return;
		if (result.kind === "primary") {
			const choice = result.items[0];
			if (!choice) return;
			this.closed = true;
			this.done(choice);
			return;
		}
		if (result.actionId === "fetch") void this.fetchBranches();
	}

	private async fetchBranches(): Promise<void> {
		const activeId = this.list.getCurrentItem()?.id;
		this.fetching = true;
		this.syncPanel();
		try {
			const choices = await this.refresh();
			if (this.closed) return;
			this.itemCount = choices.length;
			this.list.setItems(choices, activeId);
		} catch (error) {
			if (!this.closed) this.onFetchError(error);
		} finally {
			if (!this.closed) {
				this.fetching = false;
				this.syncPanel();
			}
		}
	}

	private syncPanel(): void {
		this.panelConfig.secondary = this.secondaryText();
		this.panelConfig.footer = this.footer();
		this.tui.requestRender();
	}

	private secondaryText(): string {
		return `${this.itemCount} branch${this.itemCount === 1 ? "" : "es"}`;
	}

	private footer(): ToolPanelFooter {
		return this.fetching
			? {
					kind: "infoAck",
					message: "Fetching branches…",
					hints: [bindingHint("tui.select.cancel", "cancel")],
				}
			: { kind: "hints", hints: this.list.getKeyHints() };
	}
}
