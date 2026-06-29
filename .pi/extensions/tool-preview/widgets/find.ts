import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Container, TUI } from "@earendil-works/pi-tui";
import { createToolPreviewWidget } from "./tool-preview.ts";

export function createFindPreviewWidget(tui: TUI, cwd: string, theme: Theme): Container {
	return createToolPreviewWidget(tui, cwd, theme, "find", [
		{
			name: "find",
			sampleTitle: "Grouped Paths",
			args: {
				queries: [{ path: "/Users/shanepadgett/.local/share/tau-agent/references", patterns: ["README.md"] }],
			},
			argText: "/Users/shanepadgett/.local/share/tau-agent/references (README.md)",
			result: [
				"opencode-dynamic-context-pruning/",
				"  README.md",
				"pi-model-reference-compactor/",
				"  README.md",
				"pi-vcc/",
				"  README.md",
				"src/",
				"  extensions/",
				"    search/",
				"      README.md",
			].join("\n"),
			agentResult: [
				"opencode-dynamic-context-pruning/README.md",
				"pi-model-reference-compactor/README.md",
				"pi-vcc/README.md",
				"src/extensions/search/README.md",
			].join("\n"),
		},
		{
			name: "find",
			sampleTitle: "Single Directory",
			args: { queries: [{ path: "src/extensions/explore", patterns: ["*.ts"], type: "file" }], limit: 20 },
			argText: "src/extensions/explore (*.ts,file) limit=20",
			result: ["src/extensions/explore/", "  grep.ts", "  index.ts", "  read.ts"].join("\n"),
			agentResult: "src/extensions/explore/grep.ts,index.ts,read.ts",
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
					{ path: "docs/plans", patterns: ["*explore*.md"], type: "file" },
				],
				limit: 20,
			},
			argText: "2 queries limit=20",
			result: [
				"query 1 src/extensions/explore (*.ts,file)",
				"  find.ts",
				"  grep.ts",
				"query 2 docs/plans (*explore*.md,file)",
				"  explore-ui-turn-simulation.md",
				"  explore.working.md",
			].join("\n"),
			agentResult: [
				"q1 src/extensions/explore/find.ts,grep.ts",
				"q2 docs/plans/explore-ui-turn-simulation.md,explore.working.md",
			].join("\n"),
		},
		{
			name: "find",
			sampleTitle: "Directory Type Max Depth",
			args: { queries: [{ path: "src", patterns: ["*"], type: "dir", maxDepth: 2 }], limit: 20 },
			argText: "src (*,dir) maxDepth=2 limit=20",
			result: ["src/", "  extensions/", "    explore/", "    patch/", "    search/", "  shared/"].join("\n"),
			agentResult: ["src/", "  extensions/", "    explore/", "    patch/", "    search/", "  shared/"].join("\n"),
		},
		{
			name: "find",
			sampleTitle: "Hidden No Ignore",
			args: {
				queries: [{ path: ".pi/extensions", patterns: ["*.ts"], type: "file", hidden: true, noIgnore: true }],
				limit: 20,
			},
			argText: ".pi/extensions (*.ts,file) hidden noIgnore limit=20",
			result: [".pi/extensions/tool-preview/", "  index.ts", "  widgets/", "    find.ts", "    grep.ts"].join("\n"),
			agentResult: [".pi/extensions/tool-preview/index.ts", "  widgets/find.ts,grep.ts"].join("\n"),
		},
		{
			name: "find",
			sampleTitle: "Limit Hit",
			args: { queries: [{ path: "src/extensions/search", patterns: ["*.ts"], type: "file" }], limit: 5 },
			argText: "src/extensions/search (*.ts,file) limit=5",
			result: [
				"src/extensions/search/",
				"  context-pruning.ts",
				"  evidence.ts",
				"  find.ts",
				"  forget.ts",
				"  grep.ts",
				"… omitted 17 matches (limit 5)",
			].join("\n"),
			agentResult: [
				"src/extensions/search/context-pruning.ts,evidence.ts,find.ts,forget.ts,grep.ts",
				"… omitted 17 matches (limit 5)",
			].join("\n"),
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
