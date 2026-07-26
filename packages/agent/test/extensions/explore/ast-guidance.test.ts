import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AstLanguage } from "../../../extensions/explore/ast-languages.ts";
import { effectiveAstGuidance } from "../../../extensions/explore/ast-guidance.ts";
import { createWorkspace, type Workspace } from "./helpers.ts";

describe("effective AST guidance", () => {
	let workspace: Workspace;

	beforeEach(async () => {
		workspace = await createWorkspace();
	});

	afterEach(async () => workspace.cleanup());

	async function guidance(
		supportedLanguages: () => Promise<readonly AstLanguage[]> = async () => [
			"typeScript",
			"tsx",
			"odin",
			"go",
			"rust",
			"cSharp",
			"java",
			"kotlin",
			"swift",
			"markdown",
		],
	): Promise<string | undefined> {
		return effectiveAstGuidance({
			cwd: workspace.dir,
			workerLanguages: supportedLanguages,
			discoveryBudget: 100,
		});
	}

	it("enables language-specific policy for a TypeScript repository", async () => {
		await workspace.write("src/index.ts", "export const value = 1;\n");
		const result = await guidance();
		expect(result).toContain("available here for TypeScript");
		expect(result).toContain("Outline known packages or files before reading their source");
		expect(result).toContain("other symbol views for exact declaration source");
		expect(result).toContain("symbol(signatureWithDocs)");
		expect(result).not.toContain("Odin");
	});

	it("reports mixed detected languages and prunes ignored directories", async () => {
		await workspace.write(".gitignore", "ignored/\n");
		await workspace.write("src/main.odin", "package main\n");
		await workspace.write("README.md", "# Guide\n");
		await workspace.write("ignored/hidden.ts", "export const hidden = true;\n");
		const result = await guidance();
		expect(result).toContain("available here for Odin and Markdown");
		expect(result).not.toContain("TypeScript");
	});

	it("omits AST-first policy when no supported source exists", async () => {
		await workspace.write("notes.txt", "plain text\n");
		const supportedLanguages = vi.fn(async (): Promise<readonly AstLanguage[]> => ["typeScript"]);
		expect(await guidance(supportedLanguages)).toBeUndefined();
		expect(supportedLanguages).not.toHaveBeenCalled();
	});

	it("intersects repository languages with worker capabilities", async () => {
		await workspace.write("src/index.ts", "export const value = 1;\n");
		await workspace.write("README.md", "# Guide\n");
		const result = await guidance(async () => ["markdown"]);
		expect(result).toContain("available here for Markdown");
		expect(result).not.toContain("TypeScript");
	});

	it("omits AST-first policy when worker startup or its handshake fails", async () => {
		await workspace.write("src/index.ts", "export const value = 1;\n");
		expect(
			await guidance(async () => {
				throw new Error("worker unavailable");
			}),
		).toBeUndefined();
	});
});
