import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, truncateToWidth } from "@earendil-works/pi-tui";

type ThemeColor = Parameters<Theme["fg"]>[0];

export type MarkerState = "busy" | "complete" | "muted" | "warning" | "error";

export interface MarkerOptions {
	theme: Theme;
	state: MarkerState;
	label: string;
	parts: readonly string[];
}

export class Marker implements Component {
	private readonly theme: Theme;
	private readonly state: MarkerState;
	private readonly label: string;
	private readonly parts: readonly string[];

	constructor(options: MarkerOptions) {
		this.theme = options.theme;
		this.state = options.state;
		this.label = options.label;
		this.parts = options.parts;
	}

	render(width: number): string[] {
		const color = colorForState(this.state);
		const dot = this.state === "busy" && Math.floor(Date.now() / 500) % 2 === 1 ? " " : "●";
		const text = [
			` ${this.theme.fg(color, dot)}`,
			this.theme.fg("text", this.theme.bold(this.label)),
			...this.parts.map((part) => this.theme.fg("muted", part)),
		]
			.filter(Boolean)
			.join(" ");

		return [truncateToWidth(text, width)];
	}

	invalidate(): void {}
}

function colorForState(state: MarkerState): ThemeColor {
	if (state === "warning") return "warning";
	if (state === "error") return "error";
	return "dim";
}
