import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Container, TUI } from "@earendil-works/pi-tui";
import { createToolPreviewWidget } from "./tool-preview.ts";

export function createFindPreviewWidget(tui: TUI, cwd: string, theme: Theme): Container {
	return createToolPreviewWidget(tui, cwd, theme, "find", [
		{
			name: "find",
			sampleTitle: "Single Directory",
			args: { queries: [{ path: "src/extensions/explore", patterns: ["*.ts"], type: "file" }], limit: 20 },
			argText: "src/extensions/explore (*.ts,file) limit=20",
			result: [
				"src/",
				"  extensions/",
				"    explore/",
				"      find.ts",
				"      grep.ts",
				"      index.ts",
				"      ls.ts",
				"      path-display.ts",
			].join("\n"),
			agentResult: [
				"src/",
				"  extensions/",
				"    explore/: find.ts, grep.ts, index.ts, ls.ts, path-display.ts",
			].join("\n"),
		},
		{
			name: "find",
			sampleTitle: "No Matches",
			args: { queries: [{ path: "src/extensions/explore", patterns: ["*.banana"], type: "file" }], limit: 20 },
			argText: "src/extensions/explore (*.banana,file) limit=20",
			result: "No matches",
		},
		{
			name: "find",
			sampleTitle: "Multiple Queries",
			args: {
				queries: [
					{ path: "src/extensions/explore", patterns: ["*.ts"], type: "file" },
					{ path: ".working/docs/plans", patterns: ["*explore*.md"], type: "file" },
				],
				limit: 10,
			},
			argText: "2 queries limit=10",
			result: [
				"query 1",
				"src/",
				"  extensions/",
				"    explore/",
				"      find.ts",
				"      grep.ts",
				"      index.ts",
				"      ls.ts",
				"      path-display.ts",
				"… omitted 4 matches (limit 5)",
				"query 2",
				".working/",
				"  docs/",
				"    plans/",
				"      explore.review.md",
				"      explore.spec.md",
				"      explore.technical.md",
				"      explore.working.md",
			].join("\n"),
			agentResult: [
				"q1",
				"src/",
				"  extensions/",
				"    explore/: find.ts, grep.ts, index.ts, ls.ts, path-display.ts",
				"… omitted 4 matches (limit 5)",
				"q2",
				".working/",
				"  docs/",
				"    plans/: explore.review.md, explore.spec.md, explore.technical.md, explore.working.md",
			].join("\n"),
		},
		{
			name: "find",
			sampleTitle: "Directory Type Max Depth",
			args: { queries: [{ path: "src", patterns: ["*"], type: "dir", maxDepth: 2 }], limit: 20 },
			argText: "src (*,dir) maxDepth=2 limit=20",
			result: ["src/", "  extensions/", "    explore/", "    patch/", "  shared/"].join("\n"),
			agentResult: ["src/", "  extensions/", "    explore/", "    patch/", "  shared/"].join("\n"),
		},
		{
			name: "find",
			sampleTitle: "Hidden No Ignore",
			args: {
				queries: [{ path: ".pi/extensions", patterns: ["*.ts"], type: "file", hidden: true, noIgnore: true }],
				limit: 20,
			},
			argText: ".pi/extensions (*.ts,file) hidden noIgnore limit=20",
			result: [
				".pi/",
				"  extensions/",
				"    tool-preview/",
				"      index.ts",
				"      widgets/",
				"        find.ts",
				"        grep.ts",
			].join("\n"),
			agentResult: [".pi/", "  extensions/", "    tool-preview/: index.ts", "      widgets/: find.ts, grep.ts"].join(
				"\n",
			),
		},
		{
			name: "find",
			sampleTitle: "Missing Path Error",
			args: { queries: [{ path: "src/extensions/missing", patterns: ["*.ts"], type: "file" }], limit: 20 },
			argText: "src/extensions/missing (*.ts,file) limit=20",
			result: "Path not found: src/extensions/missing",
			isError: true,
		},
	]);
}
