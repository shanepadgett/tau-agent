import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Container, TUI } from "@earendil-works/pi-tui";
import { createAstToolPreviewWidget } from "./ast-tool-preview.ts";

export function createApiDiscoverPreviewWidget(tui: TUI, cwd: string, theme: Theme): Container {
	return createAstToolPreviewWidget(tui, cwd, theme, "api_discover", [
		{
			name: "api_discover",
			sampleTitle: "Exact Name",
			args: {
				path: "packages/agent/extensions/explore",
				query: { kind: "exactName", name: "createLsTool" },
				surface: "public",
				resultLimit: 10,
			},
			target: "packages/agent/extensions/explore",
			options: "[exactName=createLsTool public limit=10]",
			result: [
				"packages/agent/extensions/explore/ls.ts:51-113(1): createLsTool — function",
				"  export function createLsTool(rowState: ToolRowStateStore)",
				'  caller: import { createLsTool } from "./ls.ts" use createLsTool',
			].join("\n"),
			declarationCount: 1,
			returnedBytes: 520,
			avoidedBytes: 151_000,
		},
		{
			name: "api_discover",
			sampleTitle: "Prefix Name Package Surface",
			args: {
				path: "packages/agent/extensions/explore",
				query: { kind: "prefixName", name: "create" },
				surface: "packageSurface",
				resultLimit: 5,
			},
			target: "packages/agent/extensions/explore",
			options: "[prefixName=create packageSurface limit=5]",
			result: [
				"packages/agent/extensions/explore/find.ts:78-147(1): createFindTool — function",
				"  export function createFindTool(rowState: ToolRowStateStore)",
				'  caller: import { createFindTool } from "./find.ts" use createFindTool',
				"",
				"packages/agent/extensions/explore/grep.ts:700-749(2): createGrepTool — function",
				"  export function createGrepTool(rowState: ToolRowStateStore)",
				'  caller: import { createGrepTool } from "./grep.ts" use createGrepTool',
				"",
				"2 candidates omitted (result limit 5)",
			].join("\n"),
			declarationCount: 5,
			returnedBytes: 1800,
			avoidedBytes: 146_200,
		},
		{
			name: "api_discover",
			sampleTitle: "Declaration Kind",
			args: {
				path: "packages/agent/extensions/explore",
				query: { kind: "declarationKind", declarationKind: "function" },
				surface: "public",
				resultLimit: 3,
			},
			target: "packages/agent/extensions/explore",
			options: "[kind=function public limit=3]",
			result: [
				"packages/agent/extensions/explore/ls.ts:51-113(1): createLsTool — function",
				"  export function createLsTool(rowState: ToolRowStateStore)",
				"",
				"18 candidates omitted (result limit 3)",
			].join("\n"),
			declarationCount: 3,
			returnedBytes: 980,
			avoidedBytes: 147_000,
		},
		{
			name: "api_discover",
			sampleTitle: "No Matches",
			args: {
				path: "packages/agent/extensions/explore",
				query: { kind: "exactName", name: "doesNotExist" },
				surface: "all",
				resultLimit: 10,
			},
			target: "packages/agent/extensions/explore",
			options: "[exactName=doesNotExist all limit=10]",
			result: "No matching declarations",
			declarationCount: 0,
			returnedBytes: 220,
			avoidedBytes: 151_780,
		},
		{
			name: "api_discover",
			sampleTitle: "File Scope Error",
			args: {
				path: "packages/agent/extensions/explore/ls.ts",
				query: { kind: "exactName", name: "createLsTool" },
				surface: "public",
				resultLimit: 10,
			},
			target: "packages/agent/extensions/explore/ls.ts",
			options: "[exactName=createLsTool public limit=10]",
			result: "api_discover requires a directory scope",
			declarationCount: 0,
			returnedBytes: 40,
			avoidedBytes: 0,
			isError: true,
		},
	]);
}
