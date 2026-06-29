import type { Theme } from "@earendil-works/pi-coding-agent";
import { Box, Container, Spacer, Text, type TUI, truncateToWidth } from "@earendil-works/pi-tui";

interface AutoreadLine {
	path: string;
	state: "reading" | "read" | "pruned";
}

export function createAutoreadPreviewWidget(_tui: TUI, _cwd: string, theme: Theme): Container {
	const container = new Container();
	container.addChild(new Text(theme.fg("text", theme.bold("Autoread Row Preview")), 1, 0));
	container.addChild(new Spacer(1));
	addAgentPreview(container, theme);
	container.addChild(new Text(theme.bold("Reading"), 1, 0));
	container.addChild(new AutoreadLineComponent(theme, { path: "src/extensions/explore/read.ts", state: "reading" }));
	container.addChild(new Spacer(1));
	container.addChild(new Text(theme.bold("Read"), 1, 0));
	container.addChild(new AutoreadLineComponent(theme, { path: "src/extensions/explore/read.ts", state: "read" }));
	container.addChild(new Spacer(1));
	container.addChild(new Text(theme.bold("Pruned"), 1, 0));
	container.addChild(new AutoreadLineComponent(theme, { path: "src/extensions/explore/read.ts", state: "pruned" }));
	return container;
}

function addAgentPreview(container: Container, theme: Theme): void {
	container.addChild(new Text(theme.bold("Agent Payload"), 1, 0));
	container.addChild(new Spacer(1));
	const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
	box.addChild(
		new Text(
			theme.fg(
				"customMessageText",
				[
					"src/extensions/explore/read.ts",
					'1: import { createReadToolDefinition } from "@earendil-works/pi-coding-agent";',
					'2: import type { ToolRowStateStore } from "../../shared/tool-row-state.ts";',
					"3:",
					"4: export function createExploreReadTool(rowState: ToolRowStateStore): ReadDefinition {",
				].join("\n"),
			),
			0,
			0,
		),
	);
	container.addChild(box);
	container.addChild(new Spacer(1));
}

class AutoreadLineComponent {
	private readonly theme: Theme;
	private readonly line: AutoreadLine;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(theme: Theme, line: AutoreadLine) {
		this.theme = theme;
		this.line = line;
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

		const dotColor = this.dotColor();
		const text = [` ${this.theme.fg(dotColor, "●")}`, this.toolName(), this.theme.fg("muted", this.line.path)].join(
			" ",
		);

		this.cachedWidth = width;
		this.cachedLines = ["", truncateToWidth(text, width)];
		return this.cachedLines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	private dotColor(): "dim" | "success" {
		switch (this.line.state) {
			case "reading":
				return "dim";
			case "read":
			case "pruned":
				return "success";
		}
	}

	private toolName(): string {
		const name = this.theme.bold("autoread");
		return this.line.state === "pruned" ? this.theme.fg("warning", name) : this.theme.fg("toolTitle", name);
	}
}
