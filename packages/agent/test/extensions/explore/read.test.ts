import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { createExploreReadTool } from "../../../extensions/explore/read.ts";
import {
	createWorkspace,
	extensionContext,
	firstText,
	renderedText,
	renderContext,
	testRowState,
	testTheme,
} from "./helpers.ts";

describe("explore read", () => {
	it("delegates plain text, 1-indexed offset, continuation, and truncation", async () => {
		const workspace = await createWorkspace();
		try {
			await workspace.write("file.txt", "one\ntwo\nthree\nfour");
			const tool = createExploreReadTool(testRowState);

			const whole = await tool.execute(
				"read",
				{ path: "file.txt" },
				undefined,
				undefined,
				extensionContext(workspace.dir),
			);
			expect(firstText(whole)).toBe("one\ntwo\nthree\nfour");

			const range = await tool.execute(
				"read",
				{ path: "@file.txt", offset: 2, limit: 2 },
				undefined,
				undefined,
				extensionContext(workspace.dir),
			);
			expect(firstText(range)).toContain("two\nthree");
			expect(firstText(range)).toContain("[1 more lines in file. Use offset=4 to continue.]");

			await workspace.write("large.txt", Array.from({ length: 2105 }, (_, i) => `line ${i + 1}`).join("\n"));
			const large = await tool.execute(
				"read",
				{ path: "large.txt" },
				undefined,
				undefined,
				extensionContext(workspace.dir),
			);
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
			await expect(
				tool.execute("read", { path: "missing.txt" }, undefined, undefined, extensionContext(workspace.dir)),
			).rejects.toThrow();
			await expect(
				tool.execute("read", { path: "dir" }, undefined, undefined, extensionContext(workspace.dir)),
			).rejects.toThrow();
			await expect(
				tool.execute(
					"read",
					{ path: "file.txt", offset: 99 },
					undefined,
					undefined,
					extensionContext(workspace.dir),
				),
			).rejects.toThrow("Offset 99 is beyond end of file");
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

	it("optionally returns source line numbers without duplicating content", async () => {
		const workspace = await createWorkspace();
		try {
			await workspace.write("file.txt", "one\ntwo\nthree\nfour");
			const tool = createExploreReadTool(testRowState);
			const result = await tool.execute(
				"read",
				{ path: "file.txt", offset: 2, limit: 2, lineNumbers: true },
				undefined,
				undefined,
				extensionContext(workspace.dir),
			);
			expect(firstText(result)).toBe("2: two\n3: three\n\n[1 more lines in file. Use offset=4 to continue.]");
		} finally {
			await workspace.cleanup();
		}
	});

	it("returns a compact marker for an unchanged repeated scope", async () => {
		const workspace = await createWorkspace();
		try {
			await workspace.write("file.txt", "one\ntwo\nthree");
			const tool = createExploreReadTool(testRowState);
			const ctx = extensionContext(workspace.dir);
			await tool.execute("first", { path: "file.txt" }, undefined, undefined, ctx);
			const repeated = await tool.execute("second", { path: "file.txt" }, undefined, undefined, ctx);
			expect(firstText(repeated)).toBe("unchanged, 3 lines");
			expect(repeated.details?.readCache?.mode).toBe("unchanged");
		} finally {
			await workspace.cleanup();
		}
	});

	it("returns a useful full-file diff after content changes", async () => {
		const workspace = await createWorkspace();
		try {
			const original = Array.from({ length: 100 }, (_, index) => `line ${index + 1}`).join("\n");
			await workspace.write("file.txt", original);
			const tool = createExploreReadTool(testRowState);
			const ctx = extensionContext(workspace.dir);
			await tool.execute("first", { path: "file.txt" }, undefined, undefined, ctx);
			await workspace.write("file.txt", original.replace("line 50", "line fifty"));
			const changed = await tool.execute("second", { path: "file.txt" }, undefined, undefined, ctx);
			expect(firstText(changed)).toContain("[read: 1 lines added, 1 removed of 100]");
			expect(firstText(changed)).toContain("-line 50");
			expect(firstText(changed)).toContain("+line fifty");
			expect(changed.details?.readCache?.mode).toBe("diff");
		} finally {
			await workspace.cleanup();
		}
	});

	it("returns every line for overlapping ranges and after any file change", async () => {
		const workspace = await createWorkspace();
		try {
			const original = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n");
			await workspace.write("file.txt", original);
			const tool = createExploreReadTool(testRowState);
			const ctx = extensionContext(workspace.dir);
			await tool.execute("first", { path: "file.txt", offset: 10, limit: 5 }, undefined, undefined, ctx);

			const overlap = await tool.execute(
				"overlap",
				{ path: "file.txt", offset: 12, limit: 5 },
				undefined,
				undefined,
				ctx,
			);
			expect(firstText(overlap)).toContain("line 12\nline 13\nline 14\nline 15\nline 16");

			await workspace.write("file.txt", original.replace("line 1", "changed elsewhere"));
			const changed = await tool.execute(
				"changed",
				{ path: "file.txt", offset: 10, limit: 5 },
				undefined,
				undefined,
				ctx,
			);
			expect(firstText(changed)).toContain("line 10\nline 11\nline 12\nline 13\nline 14");
			expect(changed.details?.readCache?.mode).toBe("baseline");
		} finally {
			await workspace.cleanup();
		}
	});

	it("returns normal content after a failed patch for the same path", async () => {
		const workspace = await createWorkspace();
		try {
			await workspace.write("file.txt", "one\ntwo\nthree");
			const tool = createExploreReadTool(testRowState);
			const ctx = {
				...extensionContext(workspace.dir),
				sessionManager: {
					getBranch() {
						return [
							{
								type: "message",
								message: {
									role: "toolResult",
									toolName: "patch",
									details: {
										status: "failed",
										failures: [{ path: "file.txt", message: "could not match" }],
									},
								},
							},
						];
					},
					getSessionId() {
						return "session";
					},
					getLeafId() {
						return "leaf";
					},
				},
			} as unknown as ExtensionContext;
			const result = await tool.execute("read", { path: "file.txt" }, undefined, undefined, ctx);
			expect(firstText(result)).toBe("one\ntwo\nthree");
			expect(result.details?.readCache?.mode).toBe("recovery");
		} finally {
			await workspace.cleanup();
		}
	});

	it("renders collapsed errors as a summarized row and expanded errors with body", () => {
		const tool = createExploreReadTool(testRowState);
		const result = {
			content: [{ type: "text" as const, text: "Offset 99 is beyond end of file" }],
			details: undefined,
		};
		const collapsed = renderedText(
			tool.renderResult?.(
				result,
				{ expanded: false, isPartial: false },
				testTheme,
				renderContext({ path: "file.txt" }, false, true),
			),
		);
		expect(collapsed).toContain("file.txt");
		expect(collapsed).toContain("error");
		expect(
			renderedText(
				tool.renderResult?.(
					result,
					{ expanded: true, isPartial: false },
					testTheme,
					renderContext({ path: "file.txt" }, true, true),
				),
			),
		).toContain("Offset 99 is beyond end of file");
	});

	it("hides the completed call renderer after reload", () => {
		const tool = createExploreReadTool(testRowState);
		const context = {
			...renderContext({ path: "file.txt" }, false),
			executionStarted: false,
		};
		expect(renderedText(tool.renderCall?.({ path: "file.txt" }, testTheme, context))).toBe("");
	});
});
