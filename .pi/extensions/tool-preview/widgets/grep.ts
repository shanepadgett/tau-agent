import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Container, TUI } from "@earendil-works/pi-tui";
import { createToolPreviewWidget } from "./tool-preview.ts";

export function createGrepPreviewWidget(tui: TUI, cwd: string, theme: Theme): Container {
	return createToolPreviewWidget(tui, cwd, theme, "grep", [
		{
			name: "grep",
			sampleTitle: "Literal Query",
			args: {
				queries: [{ patterns: ["Explore", "outline"], paths: ["packages/agent/extensions/explore/README.md"] }],
			},
			argText: "patterns=Explore,outline paths=packages/agent/extensions/explore/README.md",
			result: [
				"packages/agent/extensions/explore/README.md (23 lines)",
				"1: # Explore",
				"3: Explore gives Tau 12 structural source tools: outlines, declaration slices, discovery, structural search, graph and relationship queries, impact, and context packs.",
				"11: When `explore.read.enabled` is on (default), a full Pi `read` or autoread of a registered source file above the threshold returns an outline.",
			].join("\n"),
		},
		{
			name: "grep",
			sampleTitle: "Context Lines",
			args: {
				queries: [
					{ patterns: ["createExploreEngine"], paths: ["packages/agent/extensions/explore/index.ts"], context: 2 },
				],
			},
			argText: "patterns=createExploreEngine paths=packages/agent/extensions/explore/index.ts context=2",
			result: [
				"packages/agent/extensions/explore/index.ts (103 lines)",
				"38- \tengine?.shutdown();",
				"39- \tgraph?.clear();",
				"40: \tengine = createExploreEngine({ cwd: absoluteCwd });",
				"41- \tgraph = createFileGraph(engine);",
			].join("\n"),
		},
		{
			name: "grep",
			sampleTitle: "Multiple Queries",
			args: {
				queries: [
					{ patterns: ["# Explore"], paths: ["packages/agent/extensions/explore/README.md"] },
					{ patterns: ["createDiscoverTool"], paths: ["packages/agent/extensions/explore/tools/discover.ts"] },
				],
			},
			argText: "2 queries",
			result: [
				"query 1",
				"packages/agent/extensions/explore/README.md (23 lines)",
				"1: # Explore",
				"query 2",
				"packages/agent/extensions/explore/tools/discover.ts (207 lines)",
				"127: export function createDiscoverTool(",
			].join("\n"),
		},
		{
			name: "grep",
			sampleTitle: "No Matches",
			args: { queries: [{ patterns: ["doesNotExist"], paths: ["packages/agent/extensions/explore/README.md"] }] },
			argText: "patterns=doesNotExist paths=packages/agent/extensions/explore/README.md",
			result: "No matches",
		},
		{
			name: "grep",
			sampleTitle: "Invalid Regex Error",
			args: {
				queries: [{ patterns: ["[Explore"], paths: ["packages/agent/extensions/explore/README.md"], regex: true }],
			},
			argText: "patterns=[Explore paths=packages/agent/extensions/explore/README.md regex",
			result: ["rg: regex parse error:", "    (?:[Explore)", "       ^", "error: unclosed character class"].join(
				"\n",
			),
			isError: true,
		},
	]);
}
