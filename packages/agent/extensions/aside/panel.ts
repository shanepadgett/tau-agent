import { bindingHint, bindingsHint, ToolPanel, visibleWindow } from "@shanepadgett/tau-tui";
import { getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import {
	Markdown,
	type Component,
	type KeybindingsManager,
	truncateToWidth,
	type TUI,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

const PREVIEW_LINES = 5;
const PREVIEW_CHARACTERS = 2_000;

export interface AsideResult {
	question: string;
	answer: string;
	context: string;
}

export class AsideWidget implements Component {
	private readonly panel: ToolPanel;

	constructor(theme: Theme, question: string) {
		this.panel = new ToolPanel(theme, {
			title: "Aside · Thinking…",
			body: {
				render: (width) =>
					wrapTextWithAnsi(theme.fg("muted", question.slice(0, PREVIEW_CHARACTERS)), width)
						.slice(0, PREVIEW_LINES)
						.map((line) => truncateToWidth(line, width, "")),
				invalidate() {},
			},
			footer: { kind: "hints", hints: [] },
			border: "horizontal",
		});
	}

	render(width: number): string[] {
		return this.panel.render(width);
	}

	invalidate(): void {
		this.panel.invalidate();
	}
}

export class AsideResultPanel implements Component {
	private readonly panel: ToolPanel;
	private readonly body: AsideMarkdownBody;

	constructor(tui: TUI, theme: Theme, keys: KeybindingsManager, result: AsideResult, done: () => void) {
		this.body = new AsideMarkdownBody(tui, result.answer);
		this.panel = new ToolPanel(theme, {
			title: "Aside",
			secondary: `${result.context} · ${result.question.slice(0, 240)}`,
			body: this.body,
			footer: {
				kind: "hints",
				hints: [
					bindingsHint(["tui.select.up", "tui.select.down"], "scroll"),
					bindingHint("tui.select.confirm", "close"),
					bindingHint("tui.select.cancel", "close"),
				],
			},
			border: "box",
		});
		this.handleInput = (data) => {
			if (keys.matches(data, "tui.select.up")) this.body.scroll(-1);
			else if (keys.matches(data, "tui.select.down")) this.body.scroll(1);
			else if (keys.matches(data, "tui.select.confirm") || keys.matches(data, "tui.select.cancel")) done();
		};
	}

	handleInput: (data: string) => void;

	render(width: number): string[] {
		return this.panel.render(width);
	}

	invalidate(): void {
		this.panel.invalidate();
	}
}

class AsideMarkdownBody implements Component {
	private readonly tui: TUI;
	private readonly markdown: Markdown;
	private cursor = 0;
	private lineCount = 0;

	constructor(tui: TUI, content: string) {
		this.tui = tui;
		this.markdown = new Markdown(content, 0, 0, getMarkdownTheme());
	}

	scroll(delta: number): void {
		this.cursor = Math.min(Math.max(0, this.cursor + delta), Math.max(0, this.lineCount - 1));
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const lines = this.markdown.render(width);
		this.lineCount = lines.length;
		this.cursor = Math.min(this.cursor, Math.max(0, lines.length - 1));
		const height = Math.max(4, Math.floor(this.tui.terminal.rows * 0.9) - 8);
		const window = visibleWindow(this.cursor, lines.length, height);
		return lines.slice(window.start, window.end).map((line) => truncateToWidth(line, width, ""));
	}

	invalidate(): void {
		this.markdown.invalidate();
	}
}
