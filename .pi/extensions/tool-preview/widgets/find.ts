import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Container, TUI } from "@earendil-works/pi-tui";
import { createToolPreviewWidget } from "./tool-preview.ts";

export function createFindPreviewWidget(tui: TUI, cwd: string, theme: Theme): Container {
	return createToolPreviewWidget(tui, cwd, theme, "find", [
		{
			name: "find",
			sampleTitle: "Single Directory",
			args: {
				queries: [{ path: "packages/agent/extensions/explore/tools", patterns: ["*.ts"], type: "file" }],
				limit: 20,
			},
			argText: "packages/agent/extensions/explore/tools (*.ts,file) limit=20",
			result: [
				"packages/agent/extensions/explore/tools/",
				"  ast-search.ts",
				"  context.ts",
				"  deps.ts",
				"  discover.ts",
				"  impact.ts",
				"  outline.ts",
				"  relationships.ts",
				"  reverse-deps.ts",
				"  show.ts",
			].join("\n"),
		},
		{
			name: "find",
			sampleTitle: "Multiple Queries",
			args: {
				queries: [
					{ path: "packages/agent/extensions/explore", patterns: ["README.md"], type: "file" },
					{ path: "docs/plans/explore-specs", patterns: ["*.md"], type: "file", maxDepth: 2 },
				],
				limit: 10,
			},
			argText: "2 queries limit=10",
			result: [
				"query 1",
				"packages/agent/extensions/explore/README.md",
				"query 2",
				"docs/plans/explore-specs/",
				"  cross/",
				"    system.md",
				"  stripped.md",
			].join("\n"),
		},
		{
			name: "find",
			sampleTitle: "Hidden No Ignore",
			args: {
				queries: [{ path: ".pi/extensions", patterns: ["*.ts"], type: "file", hidden: true, noIgnore: true }],
				limit: 20,
			},
			argText: ".pi/extensions (*.ts,file) hidden noIgnore limit=20",
			result: [".pi/extensions/", "  tool-preview/", "    index.ts", "    widgets/", "      find.ts"].join("\n"),
		},
		{
			name: "find",
			sampleTitle: "Missing Path Error",
			args: { queries: [{ path: "packages/agent/extensions/missing", patterns: ["*.ts"], type: "file" }] },
			argText: "packages/agent/extensions/missing (*.ts,file)",
			result: "Path not found: packages/agent/extensions/missing",
			isError: true,
		},
	]);
}
