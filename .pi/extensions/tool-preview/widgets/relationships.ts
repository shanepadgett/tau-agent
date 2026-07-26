import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Container, TUI } from "@earendil-works/pi-tui";
import { createAstToolPreviewWidget } from "./ast-tool-preview.ts";

export function createReferencesPreviewWidget(tui: TUI, cwd: string, theme: Theme): Container {
	return createAstToolPreviewWidget(tui, cwd, theme, "references", [
		{
			name: "references",
			sampleTitle: "Direct References",
			args: { path: "packages/agent/extensions/explore", locator: 6, resultLimit: 20 },
			target: "packages/agent/extensions/explore",
			options: "[6 limit=20]",
			result: [
				"index.ts:42(10) [reference]",
				"  createAstTools(client, rowState);",
				"",
				"read.ts:88(11) [reference]",
				"  return formatPathForDisplay(path, cwd);",
			].join("\n"),
			declarationCount: 4,
			returnedBytes: 520,
			avoidedBytes: 151_000,
		},
		{
			name: "references",
			sampleTitle: "No References",
			args: { path: "packages/agent/extensions/explore", locator: 7, resultLimit: 20 },
			target: "packages/agent/extensions/explore",
			options: "[7 limit=20]",
			result: "No direct references found",
			declarationCount: 0,
			returnedBytes: 180,
			avoidedBytes: 151_820,
		},
		{
			name: "references",
			sampleTitle: "Stale Locator Error",
			args: { path: "packages/agent/extensions/explore", locator: 99, resultLimit: 20 },
			target: "packages/agent/extensions/explore",
			options: "[99 limit=20]",
			result: "Declaration locator 99 is stale. Run outline or api_discover again.",
			declarationCount: 0,
			returnedBytes: 68,
			avoidedBytes: 0,
			isError: true,
		},
	]);
}

export function createCallersPreviewWidget(tui: TUI, cwd: string, theme: Theme): Container {
	return createAstToolPreviewWidget(tui, cwd, theme, "callers", [
		{
			name: "callers",
			sampleTitle: "Direct Callers",
			args: { path: "packages/agent/extensions/explore", locator: 2, resultLimit: 20 },
			target: "packages/agent/extensions/explore",
			options: "[2 limit=20]",
			result: ["index.ts:58(10) [caller]", "  createLsTool(rowState);"].join("\n"),
			declarationCount: 1,
			returnedBytes: 280,
			avoidedBytes: 151_720,
		},
		{
			name: "callers",
			sampleTitle: "Inferred Dispatch",
			args: { path: "packages/agent/extensions/explore", locator: 15, resultLimit: 20 },
			target: "packages/agent/extensions/explore",
			options: "[15 limit=20]",
			result: [
				"ast-tools.ts:1840(20) [caller, inferred]",
				"  tools[name](args);",
				"  uncertainty: dynamic property access",
			].join("\n"),
			declarationCount: 1,
			returnedBytes: 320,
			avoidedBytes: 151_680,
		},
		{
			name: "callers",
			sampleTitle: "No Callers",
			args: { path: "packages/agent/extensions/explore", locator: 7, resultLimit: 20 },
			target: "packages/agent/extensions/explore",
			options: "[7 limit=20]",
			result: "No direct callers found",
			declarationCount: 0,
			returnedBytes: 170,
			avoidedBytes: 151_830,
		},
	]);
}

export function createCalleesPreviewWidget(tui: TUI, cwd: string, theme: Theme): Container {
	return createAstToolPreviewWidget(tui, cwd, theme, "callees", [
		{
			name: "callees",
			sampleTitle: "Direct Callees",
			args: { path: "packages/agent/extensions/explore", locator: 2, resultLimit: 20 },
			target: "packages/agent/extensions/explore",
			options: "[2 limit=20]",
			result: [
				"ls.ts:60(2) [callee]",
				"  const entries = await readdir(root);",
				"  target (30)",
				"",
				"ls.ts:72(2) [callee]",
				"  return formatPathForDisplay(entry, cwd);",
				"  target (6)",
				"",
				"ls.ts:88(2) [callee]",
				"  return truncateToWidth(line, width);",
				"  target (31)",
			].join("\n"),
			declarationCount: 6,
			returnedBytes: 540,
			avoidedBytes: 3900,
		},
		{
			name: "callees",
			sampleTitle: "No Callees",
			args: { path: "packages/agent/extensions/explore", locator: 7, resultLimit: 20 },
			target: "packages/agent/extensions/explore",
			options: "[7 limit=20]",
			result: "No direct callees found",
			declarationCount: 0,
			returnedBytes: 160,
			avoidedBytes: 1400,
		},
	]);
}

export function createImplementationsPreviewWidget(tui: TUI, cwd: string, theme: Theme): Container {
	return createAstToolPreviewWidget(tui, cwd, theme, "implementations", [
		{
			name: "implementations",
			sampleTitle: "Interface Implementations",
			args: { path: "packages/agent", locator: 44, resultLimit: 20 },
			target: "packages/agent",
			options: "[44 limit=20]",
			result: [
				"extensions/explore/ast-worker.ts:565(50) [implementation]",
				"  export class AstWorkerClient implements AstClient {",
			].join("\n"),
			declarationCount: 1,
			returnedBytes: 280,
			avoidedBytes: 2_200_000,
		},
		{
			name: "implementations",
			sampleTitle: "Ambiguous Override",
			args: { path: "packages/agent", locator: 88, resultLimit: 20 },
			target: "packages/agent",
			options: "[88 limit=20]",
			result: [
				"extensions/explore/read.ts:240(90) [override, ambiguous]",
				"  override execute() {",
				"  candidates: (91), (92); 1 omitted",
				"  uncertainty: multiple same-name candidates",
				"",
				"1 ambiguous",
			].join("\n"),
			declarationCount: 1,
			returnedBytes: 360,
			avoidedBytes: 2_199_640,
		},
		{
			name: "implementations",
			sampleTitle: "No Implementations",
			args: { path: "packages/agent/extensions/explore", locator: 6, resultLimit: 20 },
			target: "packages/agent/extensions/explore",
			options: "[6 limit=20]",
			result: "No direct implementations found",
			declarationCount: 0,
			returnedBytes: 190,
			avoidedBytes: 151_810,
		},
	]);
}
