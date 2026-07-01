import type { Theme } from "@earendil-works/pi-coding-agent";
import { Box, type Component, type Container, Spacer, Text, truncateToWidth } from "@earendil-works/pi-tui";

export function framePreviewWidget(theme: Theme, child: Component): Component {
	return new PreviewFrame(theme, child);
}

class PreviewFrame implements Component {
	private readonly theme: Theme;
	private readonly child: Component;

	constructor(theme: Theme, child: Component) {
		this.theme = theme;
		this.child = child;
	}

	render(width: number): string[] {
		if (width < 5) return this.child.render(width);
		const innerWidth = width - 4;
		const border = (text: string) => this.theme.fg("border", text);
		return [
			border(`┏${"━".repeat(width - 2)}┓`),
			...this.child
				.render(innerWidth)
				.map((line) => `${border("┃")} ${truncateToWidth(line, innerWidth, "", true)} ${border("┃")}`),
			border(`┗${"━".repeat(width - 2)}┛`),
		];
	}

	invalidate(): void {
		this.child.invalidate();
	}
}

export function addPageTitle(container: Container, theme: Theme, title: string): void {
	container.addChild(new Text(theme.fg("text", theme.bold(title)), 0, 0));
	container.addChild(new Spacer(1));
}

export function addSampleTitle(container: Container, theme: Theme, title: string): void {
	container.addChild(new Text(theme.fg("accent", theme.bold(title)), 0, 0));
	container.addChild(new Spacer(1));
}

export function addSection(container: Container, theme: Theme, title: string, rows: readonly Component[]): void {
	addSectionHeading(container, theme, title);
	for (const row of rows) container.addChild(row);
	container.addChild(new Spacer(1));
}

export function addMessageBox(container: Container, theme: Theme, title: string, message: string): void {
	addSectionHeading(container, theme, title);
	container.addChild(new Spacer(1));
	const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
	box.addChild(new Text(theme.fg("customMessageText", message), 0, 0));
	container.addChild(box);
	container.addChild(new Spacer(1));
}

export function addSectionHeading(container: Container, theme: Theme, title: string): void {
	container.addChild(new Text(theme.bold(title), 0, 0));
}
