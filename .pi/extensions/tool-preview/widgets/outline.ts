import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Container, TUI } from "@earendil-works/pi-tui";
import { createAstToolPreviewWidget } from "./ast-tool-preview.ts";

export function createOutlinePreviewWidget(tui: TUI, cwd: string, theme: Theme): Container {
	return createAstToolPreviewWidget(tui, cwd, theme, "outline", [
		{
			name: "outline",
			sampleTitle: "File Outline",
			args: { path: "packages/agent/extensions/explore/traverse.ts" },
			target: "packages/agent/extensions/explore/traverse.ts",
			result: [
				"12-14: export function stripLeadingAt(value: string): string",
				"16-18: export function toSlashPath(value: string): string",
				"20-24: export function resolveExplorePath(cwd: string, input: string): string",
				"26-34: export function pathResolutionError(error: unknown, input: string): Error",
				"36-39: export function formatPathForDisplay(absolutePath: string, cwd: string): string",
			].join("\n"),
			declarationCount: 5,
			returnedBytes: 371,
		},
		{
			name: "outline",
			sampleTitle: "Recursive Subtree",
			args: { path: "packages/agent/extensions/explore/ast/tools", recursive: true },
			target: "packages/agent/extensions/explore/ast/tools",
			options: "[recursive]",
			result: [
				"packages/agent/extensions/explore/ast/tools/outline.ts",
				"36-126: export function createOutlineTool(",
				"packages/agent/extensions/explore/ast/tools/show.ts",
				"30-108: export function createShowTool(",
			].join("\n"),
			declarationCount: 12,
			returnedBytes: 244,
		},
		{
			name: "outline",
			sampleTitle: "Exact Name Filter",
			args: { path: "packages/agent/extensions/explore/traverse.ts", names: ["resolveExplorePath"] },
			target: "packages/agent/extensions/explore/traverse.ts",
			options: "[names=resolveExplorePath]",
			result: "20-24: export function resolveExplorePath(cwd: string, input: string): string",
			declarationCount: 1,
			returnedBytes: 79,
		},
		{
			name: "outline",
			sampleTitle: "Missing Path Error",
			args: { path: "packages/agent/extensions/explore/missing.ts" },
			target: "packages/agent/extensions/explore/missing.ts",
			result: "Path not found: packages/agent/extensions/explore/missing.ts",
			declarationCount: 0,
			returnedBytes: 62,
			isError: true,
		},
	]);
}
