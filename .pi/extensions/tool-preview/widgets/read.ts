import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Container, TUI } from "@earendil-works/pi-tui";
import { createToolPreviewWidget } from "./tool-preview.ts";

export function createReadPreviewWidget(tui: TUI, cwd: string, theme: Theme): Container {
	return createToolPreviewWidget(tui, cwd, theme, "read", [
		{
			name: "read",
			sampleTitle: "Whole File",
			args: { path: "src/extensions/explore/README.md" },
			argText: "src/extensions/explore/README.md",
			result: [
				"# Explore",
				"",
				"Explore is Tau's first-party filesystem exploration extension.",
				"",
				[
					"It exists so agents can inspect paths, discover files, search text, and read file contents",
					"with compact model payloads and readable tool rows.",
				].join(" "),
				"",
				"Agents invoke it with `ls`, `find`, `grep`, and `read`.",
			].join("\n"),
		},
		{
			name: "read",
			sampleTitle: "Line Range",
			args: { path: "src/extensions/explore/README.md", offset: 3, limit: 2 },
			argText: "src/extensions/explore/README.md:3-4",
			result: [
				"Explore is Tau's first-party filesystem exploration extension.",
				"",
				"[3 more lines in file. Use offset=5 to continue.]",
			].join("\n"),
		},
		{
			name: "read",
			sampleTitle: "Huge File Truncated",
			args: { path: "logs/huge-output.txt" },
			argText: "logs/huge-output.txt",
			agentResult: ["line 1", "line 2", "…", "[Showing lines 1-2000 of 2400. Use offset=2001 to continue.]"].join(
				"\n",
			),
			result: ["line 1", "line 2", "…", "[Showing lines 1-2000 of 2400. Use offset=2001 to continue.]"].join("\n"),
		},
		{
			name: "read",
			sampleTitle: "Missing File Error",
			args: { path: "src/extensions/explore/missing.ts" },
			argText: "src/extensions/explore/missing.ts",
			result: "File not found: src/extensions/explore/missing.ts",
			isError: true,
		},
		{
			name: "read",
			sampleTitle: "Directory Path Error",
			args: { path: "src/extensions/explore" },
			argText: "src/extensions/explore",
			result: "Path is a directory: src/extensions/explore",
			isError: true,
		},
		{
			name: "read",
			sampleTitle: "Offset Beyond EOF Error",
			args: { path: "src/extensions/explore/README.md", offset: 99, limit: 4 },
			argText: "src/extensions/explore/README.md:99-102",
			result: "Offset 99 is beyond end of file (7 lines total)",
			isError: true,
		},
		{
			name: "read",
			sampleTitle: "Image File",
			args: { path: "assets/logo.png" },
			argText: "assets/logo.png",
			result: "Read image file [image/png]",
		},
	]);
}
