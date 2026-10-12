import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Container, TUI } from "@earendil-works/pi-tui";
import { createToolPreviewWidget } from "./tool-preview.ts";

export function createGrepPreviewWidget(tui: TUI, cwd: string, theme: Theme): Container {
	return createToolPreviewWidget(tui, cwd, theme, "grep", [
		{
			name: "grep",
			sampleTitle: "Literal Query",
			args: {
				queries: [{ patterns: ["Web", "codemode"], paths: ["packages/agent/extensions/web/README.md"] }],
			},
			argText: "patterns=Web,codemode paths=packages/agent/extensions/web/README.md",
			result: [
				"packages/agent/extensions/web/README.md (20 lines)",
				"1: # Web",
				"8: Both register with `codemode` exposure, so scripts call `tools.webfetch` and `tools.websearch` and only the script's output reaches the model.",
			].join("\n"),
		},
		{
			name: "grep",
			sampleTitle: "Context Lines",
			args: {
				queries: [
					{ patterns: ["createToolRowStateStore"], paths: ["packages/agent/extensions/web/index.ts"], context: 2 },
				],
			},
			argText: "patterns=createToolRowStateStore paths=packages/agent/extensions/web/index.ts context=2",
			result: [
				"packages/agent/extensions/web/index.ts (27 lines)",
				"8-",
				"9- export default function webExtension(pi: ExtensionAPI): void {",
				'10: \tconst rowState = createToolRowStateStore(pi, "web.tool-row-state");',
				"11- \tconst temporaryOutput = createTemporaryOutputStore();",
				"12- \tregisterToolGroup(pi, {",
			].join("\n"),
		},
		{
			name: "grep",
			sampleTitle: "Multiple Queries",
			args: {
				queries: [
					{ patterns: ["# Web"], paths: ["packages/agent/extensions/web/README.md"] },
					{ patterns: ["createWebSearchTool"], paths: ["packages/agent/extensions/web/websearch.ts"] },
				],
			},
			argText: "2 queries",
			result: [
				"query 1",
				"packages/agent/extensions/web/README.md (20 lines)",
				"1: # Web",
				"query 2",
				"packages/agent/extensions/web/websearch.ts (98 lines)",
				"35: export function createWebSearchTool(rowState: ToolRowStateStore, temporaryOutput: TemporaryOutputStore) {",
			].join("\n"),
		},
		{
			name: "grep",
			sampleTitle: "No Matches",
			args: { queries: [{ patterns: ["doesNotExist"], paths: ["packages/agent/extensions/web/README.md"] }] },
			argText: "patterns=doesNotExist paths=packages/agent/extensions/web/README.md",
			result: "No matches",
		},
		{
			name: "grep",
			sampleTitle: "Invalid Regex Error",
			args: {
				queries: [{ patterns: ["[Web"], paths: ["packages/agent/extensions/web/README.md"], regex: true }],
			},
			argText: "patterns=[Web paths=packages/agent/extensions/web/README.md regex",
			result: ["rg: regex parse error:", "    (?:[Web)", "       ^", "error: unclosed character class"].join("\n"),
			isError: true,
		},
	]);
}
