import { describe, expect, it } from "vitest";
import { createGrepTool, type GrepParams } from "../../../src/extensions/explore/grep.ts";
import {
	createWorkspace,
	extensionContext,
	firstText,
	renderedText,
	renderContext,
	testRowState,
	testTheme,
} from "./helpers.ts";

describe("explore grep", () => {
	it("rejects raw argv queries and invalid regex", async () => {
		const workspace = await createWorkspace();
		try {
			await workspace.write("a.txt", "alpha\n");
			const tool = createGrepTool(testRowState);
			await expect(
				tool.execute(
					"grep",
					{ queries: [["-n", "alpha"]] } as unknown as GrepParams,
					undefined,
					undefined,
					extensionContext(workspace.dir),
				),
			).rejects.toThrow("raw argv arrays");
			await expect(
				tool.execute(
					"grep",
					{ queries: [{ patterns: ["alpha"], paths: ["a.txt"], include: "*.ts" }] } as unknown as GrepParams,
					undefined,
					undefined,
					extensionContext(workspace.dir),
				),
			).rejects.toThrow("queries[0].include must be an array of strings");
			await expect(
				tool.execute(
					"grep",
					{ queries: [{ patterns: ["[alpha"], paths: ["a.txt"], regex: true }] },
					undefined,
					undefined,
					extensionContext(workspace.dir),
				),
			).rejects.toThrow("regex parse error");
		} finally {
			await workspace.cleanup();
		}
	});

	it("searches literal, regex, case, word, include/exclude, and @ paths/globs", async () => {
		const workspace = await createWorkspace();
		try {
			await workspace.write("a.txt", "Alpha\nalpha beta\nalphabet\n");
			await workspace.write("b.md", "alpha in markdown\n");
			const tool = createGrepTool(testRowState);

			const smart = await tool.execute(
				"grep",
				{ queries: [{ patterns: ["alpha"], paths: ["@a.txt"] }] },
				undefined,
				undefined,
				extensionContext(workspace.dir),
			);
			expect(firstText(smart)).toContain("1: Alpha");

			const sensitive = await tool.execute(
				"grep",
				{ queries: [{ patterns: ["alpha"], paths: ["a.txt"], case: "sensitive" }] },
				undefined,
				undefined,
				extensionContext(workspace.dir),
			);
			expect(firstText(sensitive)).not.toContain("1: Alpha");

			const word = await tool.execute(
				"grep",
				{ queries: [{ patterns: ["alpha"], paths: ["a.txt"], word: true }] },
				undefined,
				undefined,
				extensionContext(workspace.dir),
			);
			expect(firstText(word)).toContain("2: alpha beta");
			expect(firstText(word)).not.toContain("alphabet");

			const regex = await tool.execute(
				"grep",
				{ queries: [{ patterns: ["Alp.a"], paths: ["a.txt"], regex: true }] },
				undefined,
				undefined,
				extensionContext(workspace.dir),
			);
			expect(firstText(regex)).toContain("1: Alpha");

			const included = await tool.execute(
				"grep",
				{ queries: [{ patterns: ["alpha"], paths: ["."], include: ["@*.txt"], exclude: ["b.md"] }] },
				undefined,
				undefined,
				extensionContext(workspace.dir),
			);
			expect(firstText(included)).toContain("a.txt");
			expect(firstText(included)).not.toContain("b.md");
		} finally {
			await workspace.cleanup();
		}
	});

	it("handles hidden/noIgnore, context, contextOnly, multiple queries, limits, and truncation", async () => {
		const workspace = await createWorkspace();
		try {
			await workspace.write("a.txt", ["before", "needle hit", "after", "needle again", "tail"].join("\n"));
			await workspace.write(".hidden.txt", "needle hidden\n");
			await workspace.write("ignored.txt", "needle ignored\n");
			await workspace.write(".gitignore", "ignored.txt\n");
			const tool = createGrepTool(testRowState);

			const defaults = await tool.execute(
				"grep",
				{ queries: [{ patterns: ["needle"] }] },
				undefined,
				undefined,
				extensionContext(workspace.dir),
			);
			expect(firstText(defaults)).not.toContain(".hidden.txt");
			expect(firstText(defaults)).not.toContain("ignored.txt");

			const all = await tool.execute(
				"grep",
				{ queries: [{ patterns: ["needle"], hidden: true, noIgnore: true }] },
				undefined,
				undefined,
				extensionContext(workspace.dir),
			);
			expect(firstText(all)).toContain(".hidden.txt");
			expect(firstText(all)).toContain("ignored.txt");

			const context = await tool.execute(
				"grep",
				{ queries: [{ patterns: ["needle hit"], paths: ["a.txt"], context: 1 }] },
				undefined,
				undefined,
				extensionContext(workspace.dir),
			);
			expect(firstText(context)).toContain("1- before");
			expect(firstText(context)).toContain("2: needle hit");

			const contextOnly = await tool.execute(
				"grep",
				{ queries: [{ patterns: ["needle hit"], paths: ["a.txt"], context: 1 }], contextOnly: true },
				undefined,
				undefined,
				extensionContext(workspace.dir),
			);
			expect(firstText(contextOnly)).toContain("1- before");
			expect(firstText(contextOnly)).not.toContain("2: needle hit");

			const multi = await tool.execute(
				"grep",
				{
					queries: [
						{ patterns: ["needle hit"], paths: ["a.txt"] },
						{ patterns: ["tail"], paths: ["a.txt"] },
					],
				},
				undefined,
				undefined,
				extensionContext(workspace.dir),
			);
			expect(firstText(multi)).toContain("query 1");
			expect(firstText(multi)).toContain("query 2");

			const limited = await tool.execute(
				"grep",
				{ queries: [{ patterns: ["needle"], paths: ["a.txt"] }], limit: 1 },
				undefined,
				undefined,
				extensionContext(workspace.dir),
			);
			expect(firstText(limited)).toContain("… omitted 1 matches (limit 1)");

			const maxPerFile = await tool.execute(
				"grep",
				{ queries: [{ patterns: ["needle"], paths: ["a.txt"] }], maxPerFile: 1 },
				undefined,
				undefined,
				extensionContext(workspace.dir),
			);
			expect(firstText(maxPerFile)).toContain("maxPerFile 1");

			await workspace.write("long.txt", `prefix ${"x".repeat(80)} needle ${"y".repeat(80)} suffix\n`);
			const truncated = await tool.execute(
				"grep",
				{ queries: [{ patterns: ["needle"], paths: ["long.txt"] }], maxLineLength: 30 },
				undefined,
				undefined,
				extensionContext(workspace.dir),
			);
			expect(firstText(truncated)).toContain("…");

			const none = await tool.execute(
				"grep",
				{ queries: [{ patterns: ["missing"], paths: ["a.txt"] }] },
				undefined,
				undefined,
				extensionContext(workspace.dir),
			);
			expect(firstText(none)).toBe("No matches");
			await expect(
				tool.execute(
					"grep",
					{ queries: [{ patterns: ["needle"], paths: ["missing"] }] },
					undefined,
					undefined,
					extensionContext(workspace.dir),
				),
			).rejects.toThrow("Path not found: missing");
		} finally {
			await workspace.cleanup();
		}
	});

	it("keeps broad-search output bounded", async () => {
		const workspace = await createWorkspace();
		try {
			for (let i = 0; i < 40; i += 1) await workspace.write(`f${i}.txt`, "needle\nneedle\n");
			const tool = createGrepTool(testRowState);
			const result = await tool.execute(
				"grep",
				{ queries: [{ patterns: ["needle"] }], limit: 5 },
				undefined,
				undefined,
				extensionContext(workspace.dir),
			);
			expect(firstText(result).length).toBeLessThan(2000);
			expect(firstText(result)).toContain("… omitted");
		} finally {
			await workspace.cleanup();
		}
	});

	it("preserves absolute outside-cwd paths and floors numeric options", async () => {
		const workspace = await createWorkspace();
		const outside = await createWorkspace();
		try {
			await outside.write("file.txt", ["before", "needle in a long outside line", "after"].join("\n"));
			const tool = createGrepTool(testRowState);

			const result = await tool.execute(
				"grep",
				{
					queries: [{ patterns: ["needle"], paths: [outside.path("file.txt")], context: 0.9 }],
					limit: 0,
					maxLineLength: 5,
				},
				undefined,
				undefined,
				extensionContext(workspace.dir),
			);
			const text = firstText(result);
			expect(text).toContain(outside.path("file.txt").replace(/\\/g, "/"));
			expect(text).toContain("2: needle in a long");
			expect(text).not.toContain("1- before");
			expect(text).not.toContain("3- after");
		} finally {
			await outside.cleanup();
			await workspace.cleanup();
		}
	});

	it("renders collapsed errors command-only and expanded errors with body", () => {
		const tool = createGrepTool(testRowState);
		const result = { content: [{ type: "text" as const, text: "regex parse error" }], details: undefined };
		expect(
			renderedText(
				tool.renderResult?.(
					result,
					{ expanded: false, isPartial: false },
					testTheme,
					renderContext({ queries: [{ patterns: ["["] }] }, false, true),
				),
			),
		).toBe("");
		expect(
			renderedText(
				tool.renderResult?.(
					result,
					{ expanded: true, isPartial: false },
					testTheme,
					renderContext({ queries: [{ patterns: ["["] }] }, true, true),
				),
			),
		).toContain("regex parse error");
	});
});
