import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Container, TUI } from "@earendil-works/pi-tui";
import { createToolPreviewWidget } from "./tool-preview.ts";

export function createGrepPreviewWidget(tui: TUI, cwd: string, theme: Theme): Container {
	return createToolPreviewWidget(tui, cwd, theme, "grep", [
		{
			name: "grep",
			sampleTitle: "Literal Multi-pattern Query",
			args: { queries: [{ patterns: ["Explore", "read"], paths: ["src/extensions/explore/README.md"] }] },
			argText: "patterns=Explore,read paths=src/extensions/explore/README.md",
			result: [
				"src/extensions/explore/README.md (7 lines)",
				"1: # Explore",
				"3: Explore is Tau's first-party filesystem exploration extension.",
				[
					"5: It exists so agents can inspect paths, discover files, search text, and read file contents",
					"with compact model payloads and readable tool rows.",
				].join(" "),
				"7: Agents invoke it with `ls`, `find`, `grep`, and `read`.",
			].join("\n"),
		},
		{
			name: "grep",
			sampleTitle: "No Matches",
			args: { queries: [{ patterns: ["doesNotExist"], paths: ["src/extensions/explore/README.md"] }] },
			argText: "patterns=doesNotExist paths=src/extensions/explore/README.md",
			result: "No matches",
		},
		{
			name: "grep",
			sampleTitle: "Context Lines",
			args: {
				queries: [{ patterns: ["createExploreReadTool"], paths: ["src/extensions/explore/read.ts"], context: 2 }],
			},
			argText: "patterns=createExploreReadTool paths=src/extensions/explore/read.ts context=2",
			result: [
				"src/extensions/explore/read.ts (75 lines)",
				"33- }",
				"34-",
				"35: export function createExploreReadTool(rowState: ToolRowStateStore): ReadDefinition {",
				"36- \treturn {",
				"37- \t\t...createReadToolDefinition(process.cwd()),",
			].join("\n"),
		},
		{
			name: "grep",
			sampleTitle: "Context Only",
			args: {
				queries: [{ patterns: ["createExploreReadTool"], paths: ["src/extensions/explore/read.ts"], context: 2 }],
				contextOnly: true,
			},
			argText: "patterns=createExploreReadTool paths=src/extensions/explore/read.ts context=2 contextOnly",
			result: [
				"src/extensions/explore/read.ts (75 lines)",
				"33- }",
				"34-",
				"36- \treturn {",
				"37- \t\t...createReadToolDefinition(process.cwd()),",
			].join("\n"),
		},
		{
			name: "grep",
			sampleTitle: "Max Per File",
			args: { queries: [{ patterns: ["tool"], paths: ["src/extensions/explore/index.ts"] }], maxPerFile: 2 },
			argText: "patterns=tool paths=src/extensions/explore/index.ts maxPerFile=2",
			result: [
				"src/extensions/explore/index.ts (16 lines)",
				'2: import { createToolRowStateStore } from "../../shared/tool-row-state.js";',
				"9: \tconst rowState = createToolRowStateStore(pi);",
				"… omitted 3 matches in file (maxPerFile 2)",
			].join("\n"),
		},
		{
			name: "grep",
			sampleTitle: "Max Line Length",
			args: {
				queries: [{ patterns: ["compact model payloads"], paths: ["src/extensions/explore/README.md"] }],
				maxLineLength: 72,
			},
			argText: "patterns=compact model payloads paths=src/extensions/explore/README.md maxLineLength=72",
			result: [
				"src/extensions/explore/README.md (7 lines)",
				"5: …search text, and read file contents with compact model payloads and readable…",
			].join("\n"),
		},
		{
			name: "grep",
			sampleTitle: "Multiple Queries",
			args: {
				queries: [
					{ patterns: ["# Explore"], paths: ["src/extensions/explore/README.md"] },
					{ patterns: ["createGrepTool"], paths: ["src/extensions/explore/grep.ts"] },
				],
			},
			argText: "2 queries",
			result: [
				"query 1",
				"src/extensions/explore/README.md (7 lines)",
				"1: # Explore",
				"query 2",
				"src/extensions/explore/grep.ts (579 lines)",
				"534: export function createGrepTool(rowState: ToolRowStateStore) {",
			].join("\n"),
		},
		{
			name: "grep",
			sampleTitle: "Hidden No Ignore",
			args: { queries: [{ patterns: ["tool-preview"], paths: [".pi/extensions"], hidden: true, noIgnore: true }] },
			argText: "patterns=tool-preview paths=.pi/extensions hidden noIgnore",
			result: [
				".pi/extensions/tool-preview/index.ts (69 lines)",
				'10: const COMMAND = "tool-preview";',
				'21: { value: "clear", label: "clear", description: "Hide the preview widget" },',
			].join("\n"),
		},
		{
			name: "grep",
			sampleTitle: "Limit Hit",
			args: { queries: [{ patterns: ["export"], paths: ["src/extensions/explore"] }], limit: 5 },
			argText: "patterns=export paths=src/extensions/explore limit=5",
			result: [
				"src/extensions/explore/find.ts (170 lines)",
				"100: export function createFindTool(rowState: ToolRowStateStore) {",
				"src/extensions/explore/grep.ts (579 lines)",
				"46: export type GrepParams = Static<typeof grepParams>;",
				"534: export function createGrepTool(rowState: ToolRowStateStore) {",
				"src/extensions/explore/ls.ts (136 lines)",
				"73: export function createLsTool(rowState: ToolRowStateStore) {",
				"… omitted 15 matches (limit 5)",
			].join("\n"),
		},
		{
			name: "grep",
			sampleTitle: "Invalid Regex Error",
			args: { queries: [{ patterns: ["[Explore"], paths: ["src/extensions/explore/README.md"], regex: true }] },
			argText: "patterns=[Explore paths=src/extensions/explore/README.md regex",
			result: ["rg: regex parse error:", "    (?:[Explore)", "       ^", "error: unclosed character class"].join(
				"\n",
			),
			isError: true,
		},
	]);
}
