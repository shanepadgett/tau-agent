import { describe, expect, test } from "vitest";
import { prepareFileInjection } from "../../../src/file-injection/index.ts";
import { createWorkspace } from "../../helpers.ts";

describe("file injection", () => {
	test("injects selected line ranges without outlining large sources", async () => {
		const workspace = await createWorkspace();
		try {
			await workspace.write("source.ts", "one\ntwo\nthree\nfour\nfive");

			const [message] = await prepareFileInjection({
				cwd: workspace.dir,
				source: "test",
				batchId: "batch",
				files: [{ path: "source.ts", mode: "auto", ranges: [{ startLine: 2, endLine: 3 }] }],
			});

			expect(message).toMatchObject({
				content: "source.ts\ntwo\nthree",
				details: {
					kind: "full",
					ranges: [{ startLine: 2, endLine: 3 }],
				},
			});
			expect(message.details.readCache).toBeUndefined();
		} finally {
			await workspace.cleanup();
		}
	});

	test("normalizes overlapping ranges and keeps existing full reads unchanged", async () => {
		const workspace = await createWorkspace();
		try {
			await workspace.write("source.ts", "one\ntwo\nthree\nfour");

			const [ranged, full] = await prepareFileInjection({
				cwd: workspace.dir,
				source: "test",
				batchId: "batch",
				files: [
					{
						path: "source.ts",
						mode: "full",
						ranges: [
							{ startLine: 3, endLine: 4 },
							{ startLine: 1, endLine: 2 },
							{ startLine: 2, endLine: 3 },
						],
					},
					{ path: "source.ts", mode: "full" },
				],
			});

			expect(ranged.content).toBe("source.ts\none\ntwo\nthree\nfour");
			expect(ranged.details.ranges).toEqual([{ startLine: 1, endLine: 4 }]);
			expect(full.content).toBe("source.ts\none\ntwo\nthree\nfour");
			expect(full.details.ranges).toBeUndefined();
		} finally {
			await workspace.cleanup();
		}
	});

	test("returns a per-file failure for invalid range requests", async () => {
		const workspace = await createWorkspace();
		try {
			await workspace.write("source.ts", "one\ntwo");

			const [message] = await prepareFileInjection({
				cwd: workspace.dir,
				source: "test",
				batchId: "batch",
				files: [{ path: "source.ts", mode: "outline", ranges: [{ startLine: 2, endLine: 1 }] }],
			});

			expect(message.content).toContain("Line ranges must use positive, ordered line numbers");
			expect(message.details).toMatchObject({ kind: "outline", status: "failed" });
		} finally {
			await workspace.cleanup();
		}
	});
});
