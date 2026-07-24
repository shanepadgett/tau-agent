import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Text, type TUI } from "@earendil-works/pi-tui";
import { ToolPanel } from "@shanepadgett/tau-tui";

const RELEASE_STEPS = [
	"write package versions",
	"build tau-ast darwin-arm64",
	"stage tau-ast",
	"smoke test tau-ast",
	"npm pack --dry-run @shanepadgett/tau-tui",
	"npm pack --dry-run @shanepadgett/tau-agent",
	"verify packed tau-ast",
	"git add release files",
	"git commit",
	"git tag",
	"git push origin HEAD",
	"git push origin v",
	"Waiting for GitHub Actions",
	"GitHub Actions: publishing",
] as const;

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
	private readonly completed: string[] = ["Release confirmed"];

	constructor(tui: TUI, theme: Theme, tag: string) {
		this.tui = tui;
		this.theme = theme;
		this.panel = new ToolPanel(theme, {
			title: `Publishing ${tag}`,
			secondary: "Editor is unavailable until this release finishes.",
			header: [theme.fg("muted", "GitHub Actions publishes through npm trusted publishing.")],
			body: this.body,
			footer: { kind: "hints", hints: [] },
		});
		this.renderBody();
	}

	update(status: string, detail: string | undefined = undefined): void {
		if (this.status !== "Preparing release" && this.status !== status) this.completed.push(this.status);
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
		const upcoming = RELEASE_STEPS.filter(
			(step) => !this.completed.some((completed) => completed.startsWith(step)) && step !== this.status,
		);
		this.body.setText(
			[
				...this.completed.map((step) => this.theme.fg("success", `✓ ${step}`)),
				this.theme.fg("accent", `… ${this.status}`),
				...(this.detail ? [this.theme.fg("muted", this.detail)] : []),
				...upcoming.map((step) => this.theme.fg("muted", `· ${step}`)),
			].join("\n"),
		);
	}
}
