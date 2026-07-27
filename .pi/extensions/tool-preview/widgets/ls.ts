import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Container, TUI } from "@earendil-works/pi-tui";
import { createToolPreviewWidget } from "./tool-preview.ts";

export function createLsPreviewWidget(tui: TUI, cwd: string, theme: Theme): Container {
	return createToolPreviewWidget(tui, cwd, theme, "ls", [
		{
			name: "ls",
			sampleTitle: "Depth 1",
			args: { paths: ["packages/agent/extensions/explore"], depth: 1, limit: 20 },
			argText: "packages/agent/extensions/explore depth=1 limit=20",
			result: [
				"packages/agent/extensions/explore/",
				"  ast/",
				"  read/",
				"  guidance.ts",
				"  index.ts",
				"  README.md",
				"  settings.ts",
				"  traverse.ts",
			].join("\n"),
		},
		{
			name: "ls",
			sampleTitle: "Multiple Roots",
			args: { paths: ["packages/agent/extensions/explore", "docs/plans/explore-specs"], depth: 1, limit: 12 },
			argText: "packages/agent/extensions/explore docs/plans/explore-specs depth=1 limit=12",
			result: [
				"packages/agent/extensions/explore/",
				"  ast/",
				"  read/",
				"  guidance.ts",
				"  index.ts",
				"… omitted 3 entries (limit 6)",
				"",
				"docs/plans/explore-specs/",
				"  cross/",
				"  session/",
				"  stripped.md",
			].join("\n"),
		},
		{
			name: "ls",
			sampleTitle: "Single File",
			args: { paths: ["packages/agent/extensions/explore/index.ts"], depth: 1, limit: 20 },
			argText: "packages/agent/extensions/explore/index.ts",
			result: "packages/agent/extensions/explore/index.ts",
		},
		{
			name: "ls",
			sampleTitle: "Missing Path Error",
			args: { paths: ["packages/agent/extensions/missing"], depth: 1, limit: 20 },
			argText: "packages/agent/extensions/missing depth=1 limit=20",
			result: "Path not found: packages/agent/extensions/missing",
			isError: true,
		},
	]);
}
