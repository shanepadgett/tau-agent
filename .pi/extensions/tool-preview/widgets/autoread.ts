import type { Theme } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text, type TUI, truncateToWidth } from "@earendil-works/pi-tui";

interface AutoreadLine {
	path: string;
	state: "reading" | "read" | "pruned";
}

export function createAutoreadPreviewWidget(_tui: TUI, _cwd: string, theme: Theme): Container {
	const container = new Container();
	container.addChild(new Text(theme.fg("text", theme.bold("Autoread Row Preview")), 1, 0));
	container.addChild(new Spacer(1));
	container.addChild(new Text(theme.fg("accent", theme.bold("Reading")), 1, 0));
	container.addChild(new AutoreadLineComponent(theme, { path: "src/extensions/explore/read.ts", state: "reading" }));
	container.addChild(new Spacer(1));
	container.addChild(new Text(theme.fg("accent", theme.bold("Read")), 1, 0));
	container.addChild(new AutoreadLineComponent(theme, { path: "src/extensions/explore/read.ts", state: "read" }));
	container.addChild(new Spacer(1));
	container.addChild(new Text(theme.fg("accent", theme.bold("Pruned")), 1, 0));
	container.addChild(new AutoreadLineComponent(theme, { path: "src/extensions/explore/read.ts", state: "pruned" }));
	return container;
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
