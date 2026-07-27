import type { Theme } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text, type TUI } from "@earendil-works/pi-tui";
import { Marker, type MarkerState } from "@shanepadgett/tau-tui";
import { addMessageBox } from "./layout.ts";

interface AutoreadLine {
	path: string;
	state: "reading" | "read" | "pruned";
}

const samplePath = "packages/agent/extensions/explore/ast/engine.ts";

export function createAutoreadPreviewWidget(_tui: TUI, _cwd: string, theme: Theme): Container {
	const container = new Container();
	container.addChild(new Text(theme.fg("text", theme.bold("Autoread Row Preview")), 0, 0));
	container.addChild(new Spacer(1));
	addMessageBox(
		container,
		theme,
		"Agent Payload",
		[
			samplePath,
			"18-22: export type FileSource = {",
			"24-28: export type AstSearchBinding = {",
			"30-37: export type AstSearchHit = {",
			"39-60: export type ExploreEngine = {",
			"212-470: export function createExploreEngine(options: ExploreEngineOptions): ExploreEngine",
		].join("\n"),
	);
	for (const state of ["reading", "read", "pruned"] as const) {
		container.addChild(
			new Text(theme.bold(state === "read" ? "Read" : `${state[0]?.toUpperCase()}${state.slice(1)}`), 0, 0),
		);
		container.addChild(new AutoreadLineComponent(theme, { path: samplePath, state }));
		if (state !== "pruned") container.addChild(new Spacer(1));
	}
	return container;
}

class AutoreadLineComponent {
	private readonly line: Marker;

	constructor(theme: Theme, line: AutoreadLine) {
		this.line = new Marker({
			theme,
			state: markerState(line.state),
			label: "autoread",
			parts: [line.path],
		});
	}

	render(width: number): string[] {
		return this.line.render(width);
	}

	invalidate(): void {}
}

function markerState(state: AutoreadLine["state"]): MarkerState {
	if (state === "pruned") return "warning";
	return state === "reading" ? "busy" : "complete";
}
