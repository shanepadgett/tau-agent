import { bindingHint, bindingsHint, ScrollableMarkdown, ToolPanel } from "@shanepadgett/tau-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
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
	private readonly body: ScrollableMarkdown;

	constructor(tui: TUI, theme: Theme, keys: KeybindingsManager, result: AsideResult, done: () => void) {
		this.body = new ScrollableMarkdown(tui, result.answer, 8);
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
