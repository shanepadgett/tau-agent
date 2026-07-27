import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Container, TUI } from "@earendil-works/pi-tui";
import { createToolPreviewWidget } from "./tool-preview.ts";

export function createReadPreviewWidget(tui: TUI, cwd: string, theme: Theme): Container {
	return createToolPreviewWidget(tui, cwd, theme, "read", [
		{
			name: "read",
			sampleTitle: "Small Full File",
			args: { path: "packages/agent/extensions/explore/settings.ts" },
			argText: "packages/agent/extensions/explore/settings.ts",
			result: [
				'import { Type } from "typebox";',
				"",
				"export const exploreSettingsSchema = Type.Object({",
				"  // …",
				"});",
			].join("\n"),
		},
		{
			name: "read",
			sampleTitle: "Ranged Source",
			args: { path: "packages/agent/extensions/explore/ast/engine.ts", offset: 212, limit: 20 },
			argText: "packages/agent/extensions/explore/ast/engine.ts:212-231",
			result: [
				"export function createExploreEngine(options: ExploreEngineOptions): ExploreEngine {",
				"  const cwd = resolve(options.cwd);",
				"  // …",
				"}",
				"",
				"[239 more lines in file. Use offset=232 to continue.]",
			].join("\n"),
		},
		{
			name: "read",
			sampleTitle: "Large Supported Source — Outline Overlay",
			args: { path: "packages/agent/extensions/explore/ast/engine.ts" },
			argText: "packages/agent/extensions/explore/ast/engine.ts",
			result: [
				"18-22: export type FileSource = {",
				"24-28: export type AstSearchBinding = {",
				"30-37: export type AstSearchHit = {",
				"39-60: export type ExploreEngine = {",
				"212-470: export function createExploreEngine(options: ExploreEngineOptions): ExploreEngine",
			].join("\n"),
		},
		{
			name: "read",
			sampleTitle: "Missing Path Error",
			args: { path: "packages/agent/extensions/explore/missing.ts" },
			argText: "packages/agent/extensions/explore/missing.ts",
			result: "Path not found: packages/agent/extensions/explore/missing.ts",
			isError: true,
		},
	]);
}
