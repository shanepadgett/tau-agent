import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { type Component, Markdown, truncateToWidth, type TUI } from "@earendil-works/pi-tui";

/**
 * Scrolling markdown body for a `ToolPanel`. The panel owns key handling and
 * calls `scroll`; this component owns the viewport window.
 */
export class ScrollableMarkdown implements Component {
	private readonly tui: TUI;
	private readonly markdown: Markdown;
	private readonly chromeLines: number;
	private offset = 0;
	private maxOffset = 0;

	constructor(tui: TUI, content: string, chromeLines: number) {
		this.tui = tui;
		this.markdown = new Markdown(content, 0, 0, getMarkdownTheme());
		this.chromeLines = chromeLines;
	}

	scroll(delta: number): void {
		this.offset = Math.max(0, Math.min(this.maxOffset, this.offset + delta));
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const lines = this.markdown.render(width);
		const height = Math.max(4, Math.floor(this.tui.terminal.rows * 0.9) - this.chromeLines);
		this.maxOffset = Math.max(0, lines.length - height);
		this.offset = Math.min(this.offset, this.maxOffset);
		return lines.slice(this.offset, this.offset + height).map((line) => truncateToWidth(line, width, ""));
	}

	invalidate(): void {
		this.markdown.invalidate();
	}
}
