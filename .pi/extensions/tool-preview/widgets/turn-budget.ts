import type { Theme } from "@earendil-works/pi-coding-agent";
import { Box, Container, Spacer, Text, type TUI } from "@earendil-works/pi-tui";
import { LabeledDotLine } from "../../../../src/shared/tui/labeled-dot-line.ts";

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
		message: "Turn budget: 10/30 turns used for this user prompt. Batch tools when more tool work remains.",
		used: 10,
		cap: 30,
		extended: false,
	},
	{
		title: "Soft Cap Reached",
		message:
			"Turn budget: 30/30 turns used for this user prompt. Soft cap extended to 40. Batch tools when more tool work remains.",
		used: 30,
		cap: 40,
		extended: true,
	},
	{
		title: "Soft Cap Exceeded",
		message:
			"Turn budget: 35/30 turns used for this user prompt. Soft cap extended to 45. Batch tools when more tool work remains.",
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
		addSteeringMessage(container, theme, sample.message);
		addVisibleMarker(container, theme, sample);
		container.addChild(new Spacer(1));
	}

	return container;
}

function addSteeringMessage(container: Container, theme: Theme, message: string): void {
	container.addChild(new Text(theme.bold("Visible Steering Message"), 1, 0));
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
	private readonly line: LabeledDotLine;

	constructor(theme: Theme, sample: TurnBudgetSample) {
		this.line = new LabeledDotLine({
			theme,
			dotColor: "dim",
			label: "Turn Budget:",
			labelColor: "toolTitle",
			parts: [
				theme.fg("muted", `${sample.used}/${sample.cap}`),
				...(sample.extended ? [theme.fg("muted", "Soft cap extended.")] : []),
			],
		});
	}

	render(width: number): string[] {
		return this.line.render(width);
	}

	invalidate(): void {}
}
