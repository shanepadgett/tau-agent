import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { ContextPanel } from "../../../../packages/agent/extensions/context/panel.ts";
import type { ContextEntry } from "../../../../packages/agent/extensions/context/definitions.ts";

const ENTRIES: readonly ContextEntry[] = [
	{
		id: "extensions/context/selection",
		tab: "extensions",
		concept: "context",
		conceptName: "Context",
		conceptDescription: "Repository context",
		name: "selection",
		description: "Context selection and injection",
		files: [
			"packages/agent/extensions/context/index.ts",
			"packages/agent/extensions/context/panel.ts",
			"packages/agent/extensions/context/definitions.ts",
		],
		anchors: [],
		path: ".pi/contexts/extensions/context.toml",
	},
	{
		id: "extensions/context/sync",
		tab: "extensions",
		concept: "context",
		conceptName: "Context",
		conceptDescription: "Repository context",
		name: "sync",
		description: "Git-based context synchronization",
		files: ["packages/agent/extensions/context/sync.ts", "packages/agent/extensions/context/definitions.ts"],
		anchors: [],
		path: ".pi/contexts/extensions/context.toml",
	},
	{
		id: "docs/tau/external-integration",
		tab: "docs",
		concept: "tau",
		conceptName: "Tau",
		conceptDescription: "Tau documentation",
		name: "external-integration",
		description: "External integration events",
		files: ["packages/agent/docs/extending-tau-agent.md", "packages/agent/shared/events.ts"],
		anchors: [],
		path: ".pi/contexts/docs/tau.toml",
	},
];

export function createContextPreviewOverlay(
	tui: TUI,
	theme: Theme,
	done: (result: readonly ContextEntry[] | undefined) => void,
): Component {
	return new ContextPanel(tui, theme, ENTRIES, done);
}
