import type { Theme } from "@earendil-works/pi-coding-agent";
import { Box, Container, Spacer, Text, type TUI, truncateToWidth } from "@earendil-works/pi-tui";

interface TurnBudgetSample {
	title: string;
	message: string;
	used: number;
	cap: number;
	extended: boolean;
}

const SAMPLES: TurnBudgetSample[] = [
	{
		title: "Normal Boundary",
		message: "Turn budget: 10/30 tool calls used. Batch tools when possible.",
		used: 10,
		cap: 30,
		extended: false,
	},
	{
		title: "Soft Cap Reached",
		message: "Turn budget: 30/30 tool calls used. Soft cap extended to 40. Batch tools when possible.",
		used: 30,
		cap: 40,
		extended: true,
	},
	{
		title: "Soft Cap Exceeded",
		message: "Turn budget: 35/30 tool calls used. Soft cap extended to 45. Batch tools when possible.",
		used: 35,
		cap: 45,
		extended: true,
	},
];

export function createTurnBudgetPreviewWidget(_tui: TUI, _cwd: string, theme: Theme): Container {
	const container = new Container();
	container.addChild(new Text(theme.fg("text", theme.bold("Turn Budget Hint Preview")), 1, 0));
	container.addChild(new Spacer(1));

	for (const sample of SAMPLES) {
		container.addChild(new Text(theme.fg("accent", theme.bold(sample.title)), 1, 0));
		container.addChild(new Spacer(1));
		addAgentPayload(container, theme, sample.message);
		addVisibleMarker(container, theme, sample);
		container.addChild(new Spacer(1));
	}

	return container;
}

function addAgentPayload(container: Container, theme: Theme, message: string): void {
	container.addChild(new Text(theme.bold("Agent Payload"), 1, 0));
	container.addChild(new Spacer(1));
	const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
	box.addChild(new Text(theme.fg("customMessageText", message), 0, 0));
	container.addChild(box);
	container.addChild(new Spacer(1));
}

function addVisibleMarker(container: Container, theme: Theme, sample: TurnBudgetSample): void {
	container.addChild(new Text(theme.bold("Visible Marker"), 1, 0));
	container.addChild(new Spacer(1));
	container.addChild(new TurnBudgetMarker(theme, sample));
}

class TurnBudgetMarker {
	private readonly theme: Theme;
	private readonly sample: TurnBudgetSample;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(theme: Theme, sample: TurnBudgetSample) {
		this.theme = theme;
		this.sample = sample;
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

		const parts = [
			` ${this.theme.fg("dim", "●")}`,
			this.theme.fg("toolTitle", this.theme.bold("Turn Budget:")),
			this.theme.fg("muted", `${this.sample.used}/${this.sample.cap}`),
			this.sample.extended ? this.theme.fg("muted", "Soft cap extended.") : "",
		].filter(Boolean);

		this.cachedWidth = width;
		this.cachedLines = [truncateToWidth(parts.join(" "), width)];
		return this.cachedLines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}
