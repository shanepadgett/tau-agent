import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { ContextPreview } from "../../../../packages/agent/extensions/context/panel.ts";

export function createContextPreviewWidget(_tui: TUI, _cwd: string, theme: Theme): Component {
	return new ContextPreview(theme, {
		id: "extensions/context/selection",
		tab: "extensions",
		concept: "context",
		conceptName: "Context",
		conceptDescription: "Reusable repository context selection and maintenance",
		name: "selection",
		description: "Tabbed context selector, file preview, and autoread injection.",
		files: [
			"packages/agent/extensions/context/index.ts",
			"packages/agent/extensions/context/panel.ts",
			"packages/agent/shared/events.ts",
			"packages/agent/shared/injected-context.ts",
		],
		path: ".pi/contexts/extensions/context.toml",
	});
}
