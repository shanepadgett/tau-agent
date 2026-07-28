import { bindingHint, bindingsHint, rawHint, ToolPanel } from "@shanepadgett/tau-tui";
import { getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { Markdown, type Component, type KeybindingsManager, truncateToWidth, type TUI } from "@earendil-works/pi-tui";
import { formatReviewMarkdown, reviewModeLabel, type ReviewMode, type ReviewRecord } from "./model.ts";

export class ReviewProgressPanel implements Component {
	private readonly tui: TUI;
	private readonly panel: ToolPanel;
	private readonly lines: string[] = [];

	constructor(tui: TUI, theme: Theme, mode: ReviewMode, keys: KeybindingsManager, cancel: () => void) {
		this.tui = tui;
		this.panel = new ToolPanel(theme, {
			title: `${reviewModeLabel(mode)} review`,
			secondary: "Fresh isolated review · hidden from parent context",
			body: {
				render: (width) =>
					(this.lines.length ? this.lines.slice(-5) : ["Starting review"]).map((line) =>
						truncateToWidth(theme.fg("muted", line), width, "…"),
					),
				invalidate() {},
			},
			footer: { kind: "hints", hints: [bindingHint("tui.select.cancel", "cancel")] },
			border: "box",
		});
		this.handleInput = (data) => {
			if (!keys.matches(data, "tui.select.cancel")) return;
			cancel();
			this.update("Cancelling review");
		};
	}

	handleInput: (data: string) => void;

	update(status: string): void {
		if (this.lines.at(-1) !== status) {
			this.lines.push(status);
			if (this.lines.length > 5) this.lines.shift();
		}
		this.tui.requestRender();
	}

	render(width: number): string[] {
		return this.panel.render(width);
	}

	invalidate(): void {
		this.panel.invalidate();
	}
}

export type ReviewResultAction = "send" | "export" | "close";

export class ReviewResultPanel implements Component {
	private readonly panel: ToolPanel;
	private readonly body: ReviewMarkdownBody;

	constructor(
		tui: TUI,
		theme: Theme,
		keys: KeybindingsManager,
		review: ReviewRecord,
		done: (action: ReviewResultAction) => void,
	) {
		this.body = new ReviewMarkdownBody(tui, formatReviewMarkdown(review));
		this.panel = new ToolPanel(theme, {
			title: `${reviewModeLabel(review.mode)} review · ${review.verdict}`,
			secondary: `${review.findings.length} finding${review.findings.length === 1 ? "" : "s"} · not in parent context`,
			body: this.body,
			footer: {
				kind: "hints",
				hints: [
					bindingsHint(["tui.select.up", "tui.select.down"], "scroll"),
					rawHint("a", "send to agent"),
					rawHint("e", "export"),
					bindingHint("tui.select.cancel", "close"),
				],
			},
			border: "box",
		});
		this.handleInput = (data) => {
			if (keys.matches(data, "tui.select.up")) this.body.scroll(-1);
			else if (keys.matches(data, "tui.select.down")) this.body.scroll(1);
			else if (data === "a") done("send");
			else if (data === "e") done("export");
			else if (keys.matches(data, "tui.select.cancel")) done("close");
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

class ReviewMarkdownBody implements Component {
	private readonly tui: TUI;
	private readonly markdown: Markdown;
	private offset = 0;
	private maxOffset = 0;

	constructor(tui: TUI, content: string) {
		this.tui = tui;
		this.markdown = new Markdown(content, 0, 0, getMarkdownTheme());
	}

	scroll(delta: number): void {
		this.offset = Math.max(0, Math.min(this.maxOffset, this.offset + delta));
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const lines = this.markdown.render(width);
		const height = Math.max(4, Math.floor(this.tui.terminal.rows * 0.9) - 9);
		this.maxOffset = Math.max(0, lines.length - height);
		this.offset = Math.min(this.offset, this.maxOffset);
		return lines.slice(this.offset, this.offset + height);
	}

	invalidate(): void {
		this.markdown.invalidate();
	}
}
