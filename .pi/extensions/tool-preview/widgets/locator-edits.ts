import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Container, TUI } from "@earendil-works/pi-tui";
import { createAstToolPreviewWidget } from "./ast-tool-preview.ts";

export function createReplaceDeclarationPreviewWidget(tui: TUI, cwd: string, theme: Theme): Container {
	return createAstToolPreviewWidget(tui, cwd, theme, "replace_declaration", [
		{
			name: "replace_declaration",
			sampleTitle: "Replace Function",
			args: {
				locator: 6,
				source: [
					"export function formatPathForDisplay(absolutePath: string, cwd: string): string {",
					"\treturn toSlashPath(relative(cwd, absolutePath) || absolutePath);",
					"}",
				].join("\n"),
			},
			target: "formatPathForDisplay@path-display.ts",
			result: [
				"changed: packages/agent/extensions/explore/path-display.ts",
				"invalidated locators: 1, 2, 3, 4, 5, 6, 7; fresh locators: (8); skipped impacts: 0; status: completed",
			].join("\n"),
			declarationCount: 1,
			returnedBytes: 640,
			avoidedBytes: 0,
			resultNoun: "fresh locator",
		},
		{
			name: "replace_declaration",
			sampleTitle: "Stale Locator Error",
			args: { locator: 99, source: "export function gone(): void {}" },
			target: "99",
			result: "Declaration locator 99 is stale. Run outline or api_discover again.",
			declarationCount: 0,
			returnedBytes: 68,
			avoidedBytes: 0,
			resultNoun: "fresh locator",
			isError: true,
		},
	]);
}

export function createReplaceBodyPreviewWidget(tui: TUI, cwd: string, theme: Theme): Container {
	return createAstToolPreviewWidget(tui, cwd, theme, "replace_body", [
		{
			name: "replace_body",
			sampleTitle: "Replace Body",
			args: {
				locator: 6,
				body: [
					"\tconst relativePath = relative(cwd, absolutePath);",
					'\treturn relativePath === "" ? absolutePath : toSlashPath(relativePath);',
				].join("\n"),
			},
			target: "formatPathForDisplay@path-display.ts",
			result: [
				"changed: packages/agent/extensions/explore/path-display.ts",
				"invalidated locators: 6; fresh locators: (9); skipped impacts: 0; status: completed",
			].join("\n"),
			declarationCount: 1,
			returnedBytes: 480,
			avoidedBytes: 0,
			resultNoun: "fresh locator",
		},
		{
			name: "replace_body",
			sampleTitle: "Markdown Section Body",
			args: {
				locator: 12,
				body: ["Explore lists paths, finds files, greps text, and outlines supported source.", ""].join("\n"),
			},
			target: "Explore@README.md",
			result: [
				"changed: packages/agent/extensions/explore/README.md",
				"invalidated locators: 12; fresh locators: (13); skipped impacts: 0; status: completed",
			].join("\n"),
			declarationCount: 1,
			returnedBytes: 280,
			avoidedBytes: 0,
			resultNoun: "fresh locator",
		},
	]);
}

export function createInsertDeclarationPreviewWidget(tui: TUI, cwd: string, theme: Theme): Container {
	return createAstToolPreviewWidget(tui, cwd, theme, "insert_declaration", [
		{
			name: "insert_declaration",
			sampleTitle: "Insert After",
			args: {
				locator: 6,
				position: "after",
				source: [
					"export function formatPathForTitle(absolutePath: string, cwd: string): string {",
					'\treturn formatPathForDisplay(absolutePath, cwd) || ".";',
					"}",
				].join("\n"),
			},
			target: "formatPathForDisplay@path-display.ts",
			options: "[after]",
			result: [
				"changed: packages/agent/extensions/explore/path-display.ts",
				"invalidated locators: 6, 7; fresh locators: (14), (15); skipped impacts: 0; status: completed",
			].join("\n"),
			declarationCount: 2,
			returnedBytes: 620,
			avoidedBytes: 0,
			resultNoun: "fresh locator",
		},
		{
			name: "insert_declaration",
			sampleTitle: "Insert Before",
			args: {
				locator: 3,
				position: "before",
				source: 'export const EXPLORE_ROOT = ".";',
			},
			target: "resolveExplorePath@path-display.ts",
			options: "[before]",
			result: [
				"changed: packages/agent/extensions/explore/path-display.ts",
				"invalidated locators: 3, 4, 5, 6, 7; fresh locators: (16), (17); skipped impacts: 0; status: completed",
			].join("\n"),
			declarationCount: 2,
			returnedBytes: 420,
			avoidedBytes: 0,
			resultNoun: "fresh locator",
		},
	]);
}

export function createRenameDeclarationPreviewWidget(tui: TUI, cwd: string, theme: Theme): Container {
	return createAstToolPreviewWidget(tui, cwd, theme, "rename_declaration", [
		{
			name: "rename_declaration",
			sampleTitle: "File Scope Rename",
			args: {
				locator: 6,
				newName: "displayPath",
				scope: { kind: "file" },
				includeInferred: false,
			},
			target: "formatPathForDisplay@path-display.ts",
			options: "[displayPath file]",
			result: [
				"changed: packages/agent/extensions/explore/path-display.ts",
				"invalidated locators: 6; fresh locators: (18); skipped impacts: 0; status: completed",
			].join("\n"),
			declarationCount: 1,
			returnedBytes: 360,
			avoidedBytes: 0,
			resultNoun: "fresh locator",
		},
		{
			name: "rename_declaration",
			sampleTitle: "Repository Scope With Inferred",
			args: {
				locator: 6,
				newName: "displayPath",
				scope: { kind: "repository", path: "packages/agent/extensions/explore" },
				includeInferred: true,
			},
			target: "formatPathForDisplay@path-display.ts",
			options: "[displayPath repository inferred]",
			result: [
				"changed: packages/agent/extensions/explore/path-display.ts, packages/agent/extensions/explore/ls.ts",
				"invalidated locators: 6, 2; fresh locators: (18); skipped impacts: 1; status: completed",
				"skipped: packages/agent/extensions/explore/read.ts:120-120 [inferredNotApproved] candidates (19)",
			].join("\n"),
			declarationCount: 1,
			returnedBytes: 720,
			avoidedBytes: 0,
			resultNoun: "fresh locator",
		},
		{
			name: "rename_declaration",
			sampleTitle: "Ambiguous Reference Skipped",
			args: {
				locator: 3,
				newName: "resolvePath",
				scope: { kind: "repository", path: "packages/agent/extensions/explore" },
				includeInferred: false,
			},
			target: "resolveExplorePath@path-display.ts",
			options: "[resolvePath repository]",
			result: [
				"changed: packages/agent/extensions/explore/path-display.ts",
				"invalidated locators: 3; fresh locators: (22); skipped impacts: 1; status: completed",
				"skipped: packages/agent/extensions/explore/grep.ts:210-210 [ambiguous] candidates (20), (21)",
			].join("\n"),
			declarationCount: 1,
			returnedBytes: 480,
			avoidedBytes: 0,
			resultNoun: "fresh locator",
		},
	]);
}
