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
					theme.fg("success", "✓ Release confirmed"),
					theme.fg("success", "✓ write package versions"),
					theme.fg("success", "✓ npm pack --dry-run @shanepadgett/tau-tui"),
					theme.fg("success", "✓ npm pack --dry-run @shanepadgett/tau-agent"),
					theme.fg("success", "✓ git commit chore(release): v0.1.1"),
					theme.fg("success", "✓ git push origin v0.1.1"),
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
