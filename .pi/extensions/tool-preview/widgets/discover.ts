import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Container, TUI } from "@earendil-works/pi-tui";
import { createAstToolPreviewWidget } from "./ast-tool-preview.ts";

export function createDiscoverPreviewWidget(tui: TUI, cwd: string, theme: Theme): Container {
	return createAstToolPreviewWidget(tui, cwd, theme, "discover", [
		{
			name: "discover",
			sampleTitle: "Exact Name",
			args: {
				path: "packages/agent/extensions/explore",
				query: { kind: "exactName", name: "createOutlineTool" },
				surface: "public",
				resultLimit: 10,
			},
			target: "packages/agent/extensions/explore",
			options: "[exactName=createOutlineTool public limit=10]",
			result: [
				"packages/agent/extensions/explore/ast/tools/outline.ts",
				"36-126 function: export function createOutlineTool(",
				"  rowState: ToolRowStateStore,",
				"  temporaryOutput: TemporaryOutputStore,",
				"  engineFor: (cwd: string) => ExploreEngine,",
				")",
			].join("\n"),
			declarationCount: 1,
			returnedBytes: 286,
		},
		{
			name: "discover",
			sampleTitle: "Package Surface",
			args: {
				path: "packages/agent",
				query: { kind: "prefixName", name: "create" },
				surface: "packageSurface",
				resultLimit: 5,
			},
			target: "packages/agent",
			options: "[prefixName=create packageSurface limit=5]",
			result: [
				"packages/agent/src/index.ts",
				"8 function: export function createTauAgent(options: TauAgentOptions): TauAgent",
				"omitted (result limit 5)",
			].join("\n"),
			declarationCount: 5,
			returnedBytes: 178,
			truncated: true,
		},
		{
			name: "discover",
			sampleTitle: "No Matches",
			args: {
				path: "packages/agent/extensions/explore",
				query: { kind: "exactName", name: "doesNotExist" },
				surface: "all",
				resultLimit: 10,
			},
			target: "packages/agent/extensions/explore",
			options: "[exactName=doesNotExist all limit=10]",
			result: "No matching declarations.",
			declarationCount: 0,
			returnedBytes: 25,
		},
	]);
}
