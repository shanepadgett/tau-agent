import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Container, TUI } from "@earendil-works/pi-tui";
import { createAstToolPreviewWidget } from "./ast-tool-preview.ts";

export function createAstSearchPreviewWidget(tui: TUI, cwd: string, theme: Theme): Container {
	return createAstToolPreviewWidget(tui, cwd, theme, "ast_search", [
		{
			name: "ast_search",
			sampleTitle: "File Pattern",
			args: {
				path: "packages/agent/extensions/explore/ls.ts",
				pattern: "export function $NAME($$$ARGS)",
				resultLimit: 10,
			},
			target: "packages/agent/extensions/explore/ls.ts",
			options: "[infer limit=10]",
			result: [
				"ls.ts:51-113(1) [typeScript, certain]",
				"  export function createLsTool(rowState: ToolRowStateStore) {",
				'  $NAME = "createLsTool"',
				'  $ARGS = "rowState: ToolRowStateStore"',
				"  enclosing 51-113(2): function",
			].join("\n"),
			declarationCount: 1,
			returnedBytes: 420,
			avoidedBytes: 4000,
		},
		{
			name: "ast_search",
			sampleTitle: "Directory With Language",
			args: {
				path: "packages/agent/extensions/explore",
				pattern: "defineTool($PARAMS)",
				language: "typeScript",
				resultLimit: 5,
			},
			target: "packages/agent/extensions/explore",
			options: "[typeScript limit=5]",
			result: [
				"ls.ts:52-112(1) [typeScript, certain]",
				"  return defineTool({",
				'  $PARAMS = "…"',
				"  enclosing 51-113(2): function",
				"",
				"find.ts:79-146(3) [typeScript, certain]",
				"  return defineTool({",
				'  $PARAMS = "…"',
				"  enclosing 78-147(4): function",
				"",
				"3 matches omitted (result limit 5)",
				"limits reached: results",
			].join("\n"),
			declarationCount: 5,
			returnedBytes: 980,
			avoidedBytes: 147_000,
		},
		{
			name: "ast_search",
			sampleTitle: "No Matches",
			args: {
				path: "packages/agent/extensions/explore/ls.ts",
				pattern: "class $NAME { $$$BODY }",
				resultLimit: 10,
			},
			target: "packages/agent/extensions/explore/ls.ts",
			options: "[infer limit=10]",
			result: "No structural matches",
			declarationCount: 0,
			returnedBytes: 280,
			avoidedBytes: 4100,
		},
		{
			name: "ast_search",
			sampleTitle: "Missing Language Error",
			args: {
				path: "packages/agent/extensions/explore",
				pattern: "export function $NAME($$$ARGS)",
				resultLimit: 10,
			},
			target: "packages/agent/extensions/explore",
			options: "[infer limit=10]",
			result: "ast_search requires language for repository, package, and subtree targets",
			declarationCount: 0,
			returnedBytes: 74,
			avoidedBytes: 0,
			isError: true,
		},
	]);
}
