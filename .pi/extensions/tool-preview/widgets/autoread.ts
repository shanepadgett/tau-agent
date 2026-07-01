import type { Theme } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text, type TUI } from "@earendil-works/pi-tui";
import { LabeledDotLine } from "../../../../src/shared/tui/labeled-dot-line.ts";
import { addMessageBox } from "./layout.ts";

interface AutoreadLine {
	path: string;
	state: "reading" | "read" | "pruned";
}

export function createAutoreadPreviewWidget(_tui: TUI, _cwd: string, theme: Theme): Container {
	const container = new Container();
	container.addChild(new Text(theme.fg("text", theme.bold("Autoread Row Preview")), 0, 0));
	container.addChild(new Spacer(1));
	addAgentPreview(container, theme);
	container.addChild(new Text(theme.bold("Reading"), 0, 0));
	container.addChild(new AutoreadLineComponent(theme, { path: "src/extensions/explore/read.ts", state: "reading" }));
	container.addChild(new Spacer(1));
	container.addChild(new Text(theme.bold("Read"), 0, 0));
	container.addChild(new AutoreadLineComponent(theme, { path: "src/extensions/explore/read.ts", state: "read" }));
	container.addChild(new Spacer(1));
	container.addChild(new Text(theme.bold("Pruned"), 0, 0));
	container.addChild(new AutoreadLineComponent(theme, { path: "src/extensions/explore/read.ts", state: "pruned" }));
	return container;
}

function addAgentPreview(container: Container, theme: Theme): void {
	addMessageBox(
		container,
		theme,
		"Agent Payload",
		[
			"src/extensions/explore/read.ts",
			'1: import { createReadToolDefinition } from "@earendil-works/pi-coding-agent";',
			'2: import type { ToolRowStateStore } from "../../shared/tool-row-state.ts";',
			"3:",
			"4: export function createExploreReadTool(rowState: ToolRowStateStore): ReadDefinition {",
		].join("\n"),
	);
}

class AutoreadLineComponent {
	private readonly line: LabeledDotLine;

	constructor(theme: Theme, line: AutoreadLine) {
		this.line = new LabeledDotLine({
			theme,
			dotColor: line.state === "reading" ? "dim" : "success",
			label: "autoread",
			labelColor: line.state === "pruned" ? "warning" : "toolTitle",
			parts: [theme.fg("muted", line.path)],
		});
	}

	render(width: number): string[] {
		return this.line.render(width);
	}

	invalidate(): void {}
}
