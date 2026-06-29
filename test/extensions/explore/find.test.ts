import { describe, expect, it } from "vitest";
import { createFindTool } from "../../../src/extensions/explore/find.ts";
import {
	createWorkspace,
	extensionContext,
	firstText,
	renderedText,
	renderContext,
	testRowState,
	testTheme,
} from "./helpers.ts";

describe("explore find", () => {
	it("matches omitted path, @ path/glob, basename, relative path, and types", async () => {
		const workspace = await createWorkspace();
		try {
			await workspace.write("src/a.ts", "a");
			await workspace.write("src/b.md", "b");
			await workspace.write("src/nested/c.ts", "c");
			await workspace.mkdir("src/dironly");
			const tool = createFindTool(testRowState);

			const omittedPath = await tool.execute(
				"find",
				{ queries: [{ patterns: ["src/a.ts"], type: "file" }] },
				undefined,
				undefined,
				extensionContext(workspace.dir),
			);
			expect(firstText(omittedPath)).toContain("src/");
			expect(firstText(omittedPath)).toContain("a.ts");

			const atPath = await tool.execute(
				"find",
				{ queries: [{ path: "@src", patterns: ["@*.ts"], type: "file" }] },
				undefined,
				undefined,
				extensionContext(workspace.dir),
			);
			expect(firstText(atPath)).toContain("a.ts");
			expect(firstText(atPath)).toContain("c.ts");

			const relativePattern = await tool.execute(
				"find",
				{ queries: [{ path: "src", patterns: ["nested/*.ts"], type: "file" }] },
				undefined,
				undefined,
				extensionContext(workspace.dir),
			);
			expect(firstText(relativePattern)).toContain("c.ts");
			expect(firstText(relativePattern)).not.toContain("a.ts");

			const dirs = await tool.execute(
				"find",
				{ queries: [{ path: "src", type: "dir" }] },
				undefined,
				undefined,
				extensionContext(workspace.dir),
			);
			expect(firstText(dirs)).toContain("nested/");
			expect(firstText(dirs)).not.toContain("a.ts");
		} finally {
			await workspace.cleanup();
		}
	});

	it("handles maxDepth, hidden/noIgnore/noise, multiple queries, limits, and no matches", async () => {
		const workspace = await createWorkspace();
		try {
			await workspace.write("src/a.ts", "a");
			await workspace.write("src/nested/c.ts", "c");
			await workspace.write("src/nested/deep/d.ts", "d");
			await workspace.write(".hidden.ts", "hidden");
			await workspace.write("ignored.ts", "ignored");
			await workspace.write("node_modules/pkg/index.ts", "noise");
			await workspace.write(".gitignore", "ignored.ts\n");
			const tool = createFindTool(testRowState);

			const shallow = await tool.execute(
				"find",
				{ queries: [{ path: "src", patterns: ["*.ts"], type: "file", maxDepth: 1 }] },
				undefined,
				undefined,
				extensionContext(workspace.dir),
			);
			expect(firstText(shallow)).toContain("a.ts");
			expect(firstText(shallow)).not.toContain("c.ts");

			const defaults = await tool.execute("find", { queries: [{ patterns: ["*.ts"], type: "file" }] }, undefined, undefined, extensionContext(workspace.dir));
			expect(firstText(defaults)).not.toContain(".hidden.ts");
			expect(firstText(defaults)).not.toContain("ignored.ts");
			expect(firstText(defaults)).not.toContain("node_modules");

			const all = await tool.execute(
				"find",
				{ queries: [{ patterns: ["*.ts"], type: "file", hidden: true, noIgnore: true }] },
				undefined,
				undefined,
				extensionContext(workspace.dir),
			);
			expect(firstText(all)).toContain(".hidden.ts");
			expect(firstText(all)).toContain("ignored.ts");
			expect(firstText(all)).toContain("node_modules");

			const multi = await tool.execute(
				"find",
				{ queries: [{ path: "src", patterns: ["a.ts"] }, { path: "src", patterns: ["missing"] }] },
				undefined,
				undefined,
				extensionContext(workspace.dir),
			);
			expect(firstText(multi)).toContain("q1");
			expect(firstText(multi)).toContain("q2");
			expect(firstText(multi)).toContain("No matches");

			const limited = await tool.execute("find", { queries: [{ patterns: ["*.ts"] }], limit: 1 }, undefined, undefined, extensionContext(workspace.dir));
			expect(firstText(limited)).toContain("… omitted");
			await expect(tool.execute("find", { queries: [{ path: "missing" }] }, undefined, undefined, extensionContext(workspace.dir))).rejects.toThrow(
				"Path not found: missing",
			);
		} finally {
			await workspace.cleanup();
		}
	});

	it("preserves absolute outside-cwd paths and floors maxDepth", async () => {
		const workspace = await createWorkspace();
		const outside = await createWorkspace();
		try {
			await outside.write("file.ts", "file");
			await outside.write("nested/deep/hidden.ts", "deep");
			const tool = createFindTool(testRowState);

			const result = await tool.execute(
				"find",
				{ queries: [{ path: outside.dir, patterns: ["*.ts"], type: "file", maxDepth: 1.9 }] },
				undefined,
				undefined,
				extensionContext(workspace.dir),
			);
			const text = firstText(result);
			expect(text).toContain(outside.dir.replace(/\\/g, "/"));
			expect(text).toContain("file.ts");
			expect(text).not.toContain("hidden.ts");

			const rootOnly = await tool.execute(
				"find",
				{ queries: [{ path: outside.dir, patterns: ["*.ts"], type: "file", maxDepth: -1 }] },
				undefined,
				undefined,
				extensionContext(workspace.dir),
			);
			expect(firstText(rootOnly)).toBe("No matches");
		} finally {
			await outside.cleanup();
			await workspace.cleanup();
		}
	});

	it("renders collapsed errors command-only and expanded errors with body", () => {
		const tool = createFindTool(testRowState);
		const result = { content: [{ type: "text" as const, text: "Path not found: missing" }], details: undefined };
		expect(
			renderedText(
				tool.renderResult?.(
					result,
					{ expanded: false, isPartial: false },
					testTheme,
					renderContext({ queries: [{ path: "missing" }] }, false, true),
				),
			),
		).toBe("");
		expect(
			renderedText(
				tool.renderResult?.(
					result,
					{ expanded: true, isPartial: false },
					testTheme,
					renderContext({ queries: [{ path: "missing" }] }, true, true),
				),
			),
		).toContain("Path not found: missing");
	});
});
