import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Container, TUI } from "@earendil-works/pi-tui";
import { createAstToolPreviewWidget } from "./ast-tool-preview.ts";

const scope = "packages/agent/extensions/explore";

export function createReferencesPreviewWidget(tui: TUI, cwd: string, theme: Theme): Container {
	return createAstToolPreviewWidget(tui, cwd, theme, "references", [
		{
			name: "references",
			sampleTitle: "Direct References",
			args: {
				path: scope,
				targetPath: "packages/agent/extensions/explore/ast/engine.ts",
				name: "createExploreEngine",
				resultLimit: 20,
			},
			target: scope,
			options: "[createExploreEngine limit=20]",
			result: [
				"createExploreEngine  function  packages/agent/extensions/explore/ast/engine.ts:212",
				"",
				"packages/agent/extensions/explore/index.ts",
				"  L40  call  createExploreEngine({ cwd: absoluteCwd })",
			].join("\n"),
			declarationCount: 2,
			returnedBytes: 236,
		},
	]);
}

export function createCallersPreviewWidget(tui: TUI, cwd: string, theme: Theme): Container {
	return createAstToolPreviewWidget(tui, cwd, theme, "callers", [
		{
			name: "callers",
			sampleTitle: "Direct Callers",
			args: {
				path: scope,
				targetPath: "packages/agent/extensions/explore/ast/engine.ts",
				name: "createExploreEngine",
				resultLimit: 20,
			},
			target: scope,
			options: "[createExploreEngine limit=20]",
			result: [
				"createExploreEngine  function  packages/agent/extensions/explore/ast/engine.ts:212",
				"",
				"packages/agent/extensions/explore/index.ts",
				"  L40  call  createExploreEngine({ cwd: absoluteCwd })",
			].join("\n"),
			declarationCount: 2,
			returnedBytes: 236,
		},
	]);
}

export function createCalleesPreviewWidget(tui: TUI, cwd: string, theme: Theme): Container {
	return createAstToolPreviewWidget(tui, cwd, theme, "callees", [
		{
			name: "callees",
			sampleTitle: "Direct Callees",
			args: {
				path: scope,
				targetPath: "packages/agent/extensions/explore/index.ts",
				name: "exploreExtension",
				resultLimit: 20,
			},
			target: scope,
			options: "[exploreExtension limit=20]",
			result: [
				"exploreExtension  function  packages/agent/extensions/explore/index.ts:26",
				"",
				"packages/agent/extensions/explore/index.ts",
				"  L49  call  createOutlineTool(rowState, temporaryOutput, engineFor)",
				"  L50  call  createShowTool(rowState, engineFor)",
			].join("\n"),
			declarationCount: 12,
			returnedBytes: 302,
		},
	]);
}

export function createImplementationsPreviewWidget(tui: TUI, cwd: string, theme: Theme): Container {
	return createAstToolPreviewWidget(tui, cwd, theme, "implementations", [
		{
			name: "implementations",
			sampleTitle: "No Implementations",
			args: {
				path: scope,
				targetPath: "packages/agent/extensions/explore/ast/engine.ts",
				name: "ExploreEngine",
				resultLimit: 20,
			},
			target: scope,
			options: "[ExploreEngine limit=20]",
			result: [
				"ExploreEngine  typeAlias  packages/agent/extensions/explore/ast/engine.ts:39",
				"No relationship sites.",
			].join("\n"),
			declarationCount: 0,
			returnedBytes: 116,
		},
	]);
}
