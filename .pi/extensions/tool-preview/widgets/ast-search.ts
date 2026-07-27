import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Container, TUI } from "@earendil-works/pi-tui";
import { createAstToolPreviewWidget } from "./ast-tool-preview.ts";

export function createAstSearchPreviewWidget(tui: TUI, cwd: string, theme: Theme): Container {
	return createAstToolPreviewWidget(tui, cwd, theme, "ast_search", [
		{
			name: "ast_search",
			sampleTitle: "File Pattern",
			args: {
				path: "packages/agent/extensions/explore/index.ts",
				pattern: "pi.registerTool($TOOL)",
				resultLimit: 10,
			},
			target: "packages/agent/extensions/explore/index.ts",
			options: "[limit=10]",
			result: [
				"packages/agent/extensions/explore/index.ts",
				"49 pi.registerTool(createOutlineTool(rowState, temporaryOutput, engineFor))",
				"  $TOOL = createOutlineTool(rowState, temporaryOutput, engineFor)",
				"  in function exploreExtension L26",
			].join("\n"),
			declarationCount: 1,
			returnedBytes: 263,
		},
		{
			name: "ast_search",
			sampleTitle: "Directory With Language",
			args: {
				path: "packages/agent/extensions/explore/ast/tools",
				pattern: "defineTool($ARGS)",
				language: "typescript",
				resultLimit: 5,
			},
			target: "packages/agent/extensions/explore/ast/tools",
			options: "[typescript limit=5]",
			result: [
				"packages/agent/extensions/explore/ast/tools/outline.ts",
				"41-124 defineTool({ … })",
				"  $ARGS = { … }",
				"  in function createOutlineTool L36",
				"omitted (result limit 5)",
			].join("\n"),
			declarationCount: 5,
			returnedBytes: 213,
			truncated: true,
		},
		{
			name: "ast_search",
			sampleTitle: "Missing Language Error",
			args: {
				path: "packages/agent/extensions/explore/ast/tools",
				pattern: "defineTool($ARGS)",
				resultLimit: 10,
			},
			target: "packages/agent/extensions/explore/ast/tools",
			options: "[limit=10]",
			result: "Directory structural search requires language.",
			declarationCount: 0,
			returnedBytes: 46,
			isError: true,
		},
	]);
}
