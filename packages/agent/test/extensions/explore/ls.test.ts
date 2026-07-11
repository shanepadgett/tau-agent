import { describe, expect, it } from "vitest";
import { createLsTool } from "../../../extensions/explore/ls.ts";
import {
	createWorkspace,
	extensionContext,
	firstText,
	renderedText,
	renderContext,
	testRowState,
	testTheme,
} from "./helpers.ts";

describe("explore ls", () => {
	it("lists default paths with sorting and default filtering", async () => {
		const workspace = await createWorkspace();
		try {
			await workspace.write("b.txt", "b");
			await workspace.write("a.txt", "a");
			await workspace.write("dir/z.txt", "z");
			await workspace.write("dir/a.txt", "a");
			await workspace.write(".hidden", "hidden");
			await workspace.write("node_modules/pkg/index.js", "ignored noise");
			await workspace.write("ignored.txt", "ignored");
			await workspace.write(".gitignore", "ignored.txt\n");

			const tool = createLsTool(testRowState);
			const result = await tool.execute("ls", {}, undefined, undefined, extensionContext(workspace.dir));
			const agent = firstText(result);
			const human = result.details?.humanText ?? agent;

			expect(agent).toContain("./");
			expect(agent).toContain("dir/");
			expect(agent).toContain("a.txt");
			expect(agent).toContain("b.txt");
			expect(agent).not.toContain(".hidden");
			expect(agent).not.toContain("node_modules");
			expect(agent).not.toContain("ignored.txt");
			expect(human.indexOf("dir/")).toBeLessThan(human.indexOf("a.txt"));
		} finally {
			await workspace.cleanup();
		}
	});

	it("handles @ paths, files, empty directories, all, long, and limits", async () => {
		const workspace = await createWorkspace();
		try {
			await workspace.write("dir/file.txt", "hello");
			await workspace.mkdir("empty");
			await workspace.write(".hidden", "hidden");
			await workspace.write("node_modules/pkg/index.js", "noise");
			await workspace.write("ignored.txt", "ignored");
			await workspace.write(".gitignore", "ignored.txt\n");
			const tool = createLsTool(testRowState);

			const atPath = await tool.execute(
				"ls",
				{ paths: ["@dir"] },
				undefined,
				undefined,
				extensionContext(workspace.dir),
			);
			expect(firstText(atPath)).toContain("dir/");

			const file = await tool.execute(
				"ls",
				{ paths: ["dir/file.txt"] },
				undefined,
				undefined,
				extensionContext(workspace.dir),
			);
			expect(firstText(file)).toBe("dir/file.txt");

			const empty = await tool.execute(
				"ls",
				{ paths: ["empty"] },
				undefined,
				undefined,
				extensionContext(workspace.dir),
			);
			expect(empty.details?.humanText ?? firstText(empty)).toContain("[empty]");

			const all = await tool.execute("ls", { all: true }, undefined, undefined, extensionContext(workspace.dir));
			expect(firstText(all)).toContain(".hidden");
			expect(firstText(all)).toContain("node_modules");
			expect(firstText(all)).toContain("ignored.txt");

			const long = await tool.execute(
				"ls",
				{ paths: ["dir/file.txt"], long: true },
				undefined,
				undefined,
				extensionContext(workspace.dir),
			);
			expect(firstText(long)).toMatch(/dir\/file\.txt .*\d{4}-\d{2}-\d{2}/);

			const limited = await tool.execute("ls", { limit: 1 }, undefined, undefined, extensionContext(workspace.dir));
			expect(firstText(limited)).toContain("… omitted");
		} finally {
			await workspace.cleanup();
		}
	});

	it("divides budget across roots and reports missing paths", async () => {
		const workspace = await createWorkspace();
		try {
			await workspace.write("one/a.txt", "a");
			await workspace.write("two/b.txt", "b");
			const tool = createLsTool(testRowState);
			const result = await tool.execute(
				"ls",
				{ paths: ["one", "two"], limit: 2 },
				undefined,
				undefined,
				extensionContext(workspace.dir),
			);
			const text = firstText(result);
			expect(text).toContain("one/");
			expect(text).toContain("two/");
			await expect(
				tool.execute("ls", { paths: ["missing"] }, undefined, undefined, extensionContext(workspace.dir)),
			).rejects.toThrow("Path not found: missing");
		} finally {
			await workspace.cleanup();
		}
	});

	it("preserves absolute outside-cwd paths and normalizes numeric depth/limit", async () => {
		const workspace = await createWorkspace();
		const outside = await createWorkspace();
		try {
			await workspace.write("root/child.txt", "child");
			await outside.write("outside.txt", "outside");
			const tool = createLsTool(testRowState);

			const absolutePath = outside.path("outside.txt").replace(/\\/g, "/");
			const outsideResult = await tool.execute(
				"ls",
				{ paths: [outside.path("outside.txt")] },
				undefined,
				undefined,
				extensionContext(workspace.dir),
			);
			expect(firstText(outsideResult)).toBe(absolutePath);

			const rootOnly = await tool.execute(
				"ls",
				{ paths: ["root"], depth: -1, limit: 0 },
				undefined,
				undefined,
				extensionContext(workspace.dir),
			);
			expect(firstText(rootOnly)).toBe("root/");
			expect(firstText(rootOnly)).not.toContain("child.txt");
		} finally {
			await outside.cleanup();
			await workspace.cleanup();
		}
	});

	it("renders collapsed errors command-only and expanded errors with body", () => {
		const tool = createLsTool(testRowState);
		const result = { content: [{ type: "text" as const, text: "Path not found: missing" }], details: undefined };
		expect(
			renderedText(
				tool.renderResult?.(
					result,
					{ expanded: false, isPartial: false },
					testTheme,
					renderContext({}, false, true),
				),
			),
		).toBe("");
		expect(
			renderedText(
				tool.renderResult?.(result, { expanded: true, isPartial: false }, testTheme, renderContext({}, true, true)),
			),
		).toContain("Path not found: missing");
	});
});
