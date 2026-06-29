import { describe, expect, it } from "vitest";
import { createExploreReadTool } from "../../../src/extensions/explore/read.ts";
import { createWorkspace, extensionContext, firstText, renderedText, renderContext, testRowState, testTheme } from "./helpers.ts";

describe("explore read", () => {
	it("delegates plain text, 1-indexed offset, continuation, and truncation", async () => {
		const workspace = await createWorkspace();
		try {
			await workspace.write("file.txt", "one\ntwo\nthree\nfour");
			const tool = createExploreReadTool(testRowState);

			const whole = await tool.execute("read", { path: "file.txt" }, undefined, undefined, extensionContext(workspace.dir));
			expect(firstText(whole)).toBe("one\ntwo\nthree\nfour");

			const range = await tool.execute("read", { path: "@file.txt", offset: 2, limit: 2 }, undefined, undefined, extensionContext(workspace.dir));
			expect(firstText(range)).toContain("two\nthree");
			expect(firstText(range)).toContain("[1 more lines in file. Use offset=4 to continue.]");

			await workspace.write("large.txt", Array.from({ length: 2105 }, (_, i) => `line ${i + 1}`).join("\n"));
			const large = await tool.execute("read", { path: "large.txt" }, undefined, undefined, extensionContext(workspace.dir));
			expect(firstText(large)).toContain("[Showing lines 1-2000 of 2105. Use offset=2001 to continue.]");
		} finally {
			await workspace.cleanup();
		}
	});

	it("reports missing, directory, and offset errors", async () => {
		const workspace = await createWorkspace();
		try {
			await workspace.write("file.txt", "one\ntwo");
			await workspace.mkdir("dir");
			const tool = createExploreReadTool(testRowState);
			await expect(tool.execute("read", { path: "missing.txt" }, undefined, undefined, extensionContext(workspace.dir))).rejects.toThrow();
			await expect(tool.execute("read", { path: "dir" }, undefined, undefined, extensionContext(workspace.dir))).rejects.toThrow();
			await expect(tool.execute("read", { path: "file.txt", offset: 99 }, undefined, undefined, extensionContext(workspace.dir))).rejects.toThrow(
				"Offset 99 is beyond end of file",
			);
		} finally {
			await workspace.cleanup();
		}
	});

	it("accepts absolute paths outside cwd", async () => {
		const workspace = await createWorkspace();
		const outside = await createWorkspace();
		try {
			await outside.write("file.txt", "outside");
			const tool = createExploreReadTool(testRowState);
			const result = await tool.execute(
				"read",
				{ path: outside.path("file.txt") },
				undefined,
				undefined,
				extensionContext(workspace.dir),
			);
			expect(firstText(result)).toBe("outside");
		} finally {
			await outside.cleanup();
			await workspace.cleanup();
		}
	});

	it("renders collapsed errors command-only and expanded errors with body", () => {
		const tool = createExploreReadTool(testRowState);
		const result = { content: [{ type: "text" as const, text: "Offset 99 is beyond end of file" }], details: undefined };
		expect(renderedText(tool.renderResult?.(result, { expanded: false, isPartial: false }, testTheme, renderContext({ path: "file.txt" }, false, true)))).toBe("");
		expect(renderedText(tool.renderResult?.(result, { expanded: true, isPartial: false }, testTheme, renderContext({ path: "file.txt" }, true, true)))).toContain(
			"Offset 99 is beyond end of file",
		);
	});
});
