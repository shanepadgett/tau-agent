import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Text, type TUI } from "@earendil-works/pi-tui";
import { ToolPanel } from "@shanepadgett/tau-tui";

export interface PublishProgress {
	update(status: string, detail?: string): void;
}

export class PublishActivityPanel implements Component, PublishProgress {
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly body = new Text("", 0, 0);
	private readonly panel: ToolPanel;
	private status = "Preparing release";
	private detail: string | undefined;

	constructor(tui: TUI, theme: Theme, tag: string) {
		this.tui = tui;
		this.theme = theme;
		this.panel = new ToolPanel(theme, {
			title: `Publishing ${tag}`,
			secondary: "Editor is unavailable until this release finishes.",
			header: [theme.fg("muted", "GitHub Actions publishes through npm trusted publishing.")],
			body: this.body,
			footer: { kind: "infoAck", message: "Publishing…", hints: [] },
		});
		this.renderBody();
	}

	update(status: string, detail: string | undefined = undefined): void {
		this.status = status;
		this.detail = detail;
		this.renderBody();
		this.tui.requestRender();
	}

	render(width: number): string[] {
		return this.panel.render(width);
	}

	invalidate(): void {
		this.panel.invalidate();
	}

	private renderBody(): void {
		this.body.setText(
			[
				this.theme.fg("success", "✓ Release confirmed"),
				this.theme.fg("accent", `… ${this.status}`),
				...(this.detail ? [this.theme.fg("muted", this.detail)] : []),
			].join("\n"),
		);
	}
}
