import type { Theme } from "@earendil-works/pi-coding-agent";
import { getKeybindings, type Component, type TUI, truncateToWidth } from "@earendil-works/pi-tui";
import { bindingHint, ToolPanel, type ToolPanelConfig } from "@shanepadgett/tau-tui";

export class CostReportStatusPanel implements Component {
	private readonly tui: TUI;
	private readonly panel: ToolPanel;
	private readonly config: ToolPanelConfig;
	private readonly controller = new AbortController();
	private readonly startedAt = Date.now();
	private readonly timer: ReturnType<typeof setInterval>;
	private status = "Starting…";
	private readonly secondary: string;

	constructor(tui: TUI, theme: Theme, secondary: string) {
		this.tui = tui;
		this.secondary = secondary;
		this.config = {
			title: "Cost report",
			secondary,
			body: {
				render: (width) => [truncateToWidth(theme.fg("muted", this.status), width, "…")],
				invalidate: () => {},
			},
			footer: { kind: "hints", hints: [bindingHint("tui.select.cancel", "cancel")] },
			border: "box",
		};
		this.panel = new ToolPanel(theme, this.config);
		this.timer = setInterval(() => this.tui.requestRender(), 1_000);
		this.timer.unref();
	}

	get signal(): AbortSignal {
		return this.controller.signal;
	}

	handleInput(data: string): void {
		if (!getKeybindings().matches(data, "tui.select.cancel")) return;
		if (this.controller.signal.aborted) return;
		this.update("Cancelling…");
		this.controller.abort();
	}

	update(status: string): void {
		this.status = status.trim() || this.status;
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const elapsed = Math.floor((Date.now() - this.startedAt) / 1_000);
		const clock = elapsed < 60 ? `${elapsed}s` : `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`;
		this.config.title = `Cost report · ${clock}`;
		this.config.secondary = this.secondary;
		return this.panel.render(width);
	}

	invalidate(): void {
		this.panel.invalidate();
	}

	dispose(): void {
		clearInterval(this.timer);
	}
}
