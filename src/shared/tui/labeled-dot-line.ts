import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, truncateToWidth } from "@earendil-works/pi-tui";

type ThemeColor = Parameters<Theme["fg"]>[0];

interface LabeledDotLineOptions {
	theme: Theme;
	dotColor: ThemeColor;
	label: string;
	labelColor: ThemeColor;
	parts: readonly string[];
}

export class LabeledDotLine implements Component {
	private readonly theme: Theme;
	private readonly dotColor: ThemeColor;
	private readonly label: string;
	private readonly labelColor: ThemeColor;
	private readonly parts: readonly string[];
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(options: LabeledDotLineOptions) {
		this.theme = options.theme;
		this.dotColor = options.dotColor;
		this.label = options.label;
		this.labelColor = options.labelColor;
		this.parts = options.parts;
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

		const text = [
			` ${this.theme.fg(this.dotColor, "●")}`,
			this.theme.fg(this.labelColor, this.theme.bold(this.label)),
			...this.parts,
		]
			.filter(Boolean)
			.join(" ");

		this.cachedWidth = width;
		this.cachedLines = [truncateToWidth(text, width)];
		return this.cachedLines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}
