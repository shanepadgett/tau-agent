import type { Theme } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text, type TUI } from "@earendil-works/pi-tui";
import { ToolPanel } from "@shanepadgett/tau-tui";

export function createPublishPreviewWidget(_tui: TUI, _cwd: string, theme: Theme): Container {
	const container = new Container();
	container.addChild(new Text(theme.fg("text", theme.bold("Publish Activity Preview")), 0, 0));
	container.addChild(new Spacer(1));
	container.addChild(
		new ToolPanel(theme, {
			title: "Publishing v0.1.1",
			secondary: "Editor is unavailable until this release finishes.",
			header: [theme.fg("muted", "GitHub Actions publishes through npm trusted publishing.")],
			body: new Text(
				[
					theme.fg("success", "✓ Release plan confirmed"),
					theme.fg("success", "✓ Version files updated"),
					theme.fg("success", "✓ Packages packed"),
					theme.fg("success", "✓ Tag v0.1.1 pushed"),
					theme.fg("accent", "… GitHub Actions: publishing"),
					theme.fg("muted", "  @shanepadgett/tau-tui"),
					theme.fg("muted", "  @shanepadgett/tau-agent"),
				].join("\n"),
			),
			footer: { kind: "hints", hints: [] },
		}),
	);
	return container;
}
