import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Container, TUI } from "@earendil-works/pi-tui";
import { createToolPreviewWidget } from "./tool-preview.ts";

export function createLsPreviewWidget(tui: TUI, cwd: string, theme: Theme): Container {
	return createToolPreviewWidget(tui, cwd, theme, "ls", [
		{
			name: "ls",
			sampleTitle: "Depth 1",
			args: { paths: ["src/extensions/explore"], depth: 1, limit: 20 },
			argText: "src/extensions/explore depth=1 limit=20",
			result: [
				"src/extensions/explore/",
				"  find.ts",
				"  grep.ts",
				"  index.ts",
				"  ls.ts",
				"  path-display.ts",
				"  path-tree.ts",
				"  read.ts",
				"  README.md",
				"  result.ts",
				"  traverse.ts",
			].join("\n"),
			agentResult: [
				[
					"src/extensions/explore/: find.ts, grep.ts, index.ts, ls.ts, path-display.ts,",
					"path-tree.ts, read.ts, README.md, result.ts, traverse.ts",
				].join(" "),
			].join("\n"),
		},
		{
			name: "ls",
			sampleTitle: "Multiple Roots",
			args: { paths: ["src/extensions/explore", ".working/docs/plans"], depth: 1, limit: 12 },
			argText: "src/extensions/explore .working/docs/plans depth=1 limit=12",
			result: [
				"src/extensions/explore/",
				"  find.ts",
				"  grep.ts",
				"  index.ts",
				"  ls.ts",
				"  path-display.ts",
				"… omitted 5 entries (limit 6)",
				"",
				".working/docs/plans/",
				"  explore.review.md",
				"  explore.spec.md",
				"  explore.technical.md",
				"  explore.working.md",
			].join("\n"),
			agentResult: [
				"src/extensions/explore/: find.ts, grep.ts, index.ts, ls.ts, path-display.ts",
				"… omitted 5 entries (limit 6)",
				"",
				".working/docs/plans/: explore.review.md, explore.spec.md, explore.technical.md, explore.working.md",
			].join("\n"),
		},
		{
			name: "ls",
			sampleTitle: "Empty Directory",
			args: { paths: ["src/extensions/explore/fixtures/empty"], depth: 1, limit: 20 },
			argText: "src/extensions/explore/fixtures/empty depth=1 limit=20",
			result: ["src/extensions/explore/fixtures/empty/", "  [empty]"].join("\n"),
			agentResult: "src/extensions/explore/fixtures/empty/ [empty]",
		},
		{
			name: "ls",
			sampleTitle: "Single File",
			args: { paths: ["src/extensions/explore/index.ts"], depth: 1, limit: 20 },
			argText: "src/extensions/explore/index.ts",
			result: "src/extensions/explore/index.ts",
			agentResult: "src/extensions/explore/index.ts",
		},
		{
			name: "ls",
			sampleTitle: "Long Listing",
			args: { paths: ["src/extensions/explore"], depth: 1, long: true, limit: 4 },
			argText: "src/extensions/explore depth=1 long limit=4",
			result: [
				"src/extensions/explore/ dir 2026-06-29",
				"  find.ts 7.1 KB 2026-06-29",
				"  grep.ts 13.9 KB 2026-06-29",
				"  index.ts 560 B 2026-06-29",
				"… omitted 7 entries (limit 4)",
			].join("\n"),
			agentResult: [
				[
					"src/extensions/explore/ dir 2026-06-29: find.ts 7.1 KB 2026-06-29,",
					"grep.ts 13.9 KB 2026-06-29, index.ts 560 B 2026-06-29",
				].join(" "),
				"… omitted 7 entries (limit 4)",
			].join("\n"),
		},
		{
			name: "ls",
			sampleTitle: "Missing Path Error",
			args: { paths: ["src/extensions/missing"], depth: 1, limit: 20 },
			argText: "src/extensions/missing depth=1 limit=20",
			result: "Path not found: src/extensions/missing",
			isError: true,
		},
	]);
}
