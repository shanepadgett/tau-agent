import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { generateUnifiedPatch, truncateHead } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
	createCompleteFileMeta,
	estimateTokens,
	selectCompleteFileResponse,
} from "../../../extensions/explore/full-file-knowledge.ts";
import { createReadCacheStore } from "../../../extensions/explore/read-cache.ts";
import { createExploreReadTool } from "../../../extensions/explore/read.ts";
import { createReadSnapshotStore, type ReadSnapshotStore } from "../../../extensions/explore/read-snapshots.ts";
import { branchExtensionContext, createWorkspace, firstText, testRowState } from "./helpers.ts";

function hash(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

function baselineMessage(cwd: string, path: string, source: string, presentation: "plain" | "line-numbered" = "plain") {
	const body =
		presentation === "plain"
			? source
			: source
					.split("\n")
					.map((line, index) => `${index + 1}: ${line}`)
					.join("\n");
	return {
		customType: "tau.autoread",
		content: `${path}\n${body}`,
		details: {
			path,
			cwd,
			status: "read",
			readCache: createCompleteFileMeta({
				pathKey: resolve(cwd, path),
				presentation,
				servedHash: hash(source),
				mode: "baseline",
				sourceText: source,
				returnedText: `${path}\n${body}`,
				totalLines: source.split("\n").length,
				summary: `${source.split("\n").length} lines`,
			}),
		},
	};
}

function applyUnifiedPatch(source: string, response: string): string {
	const patch = response.slice(response.indexOf("\n") + 1).split("\n");
	const sourceLines = source.split("\n");
	const output: string[] = [];
	let sourceIndex = 0;
	let index = 0;
	while (index < patch.length) {
		const match = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(patch[index] ?? "");
		if (!match) {
			index += 1;
			continue;
		}
		const oldStart = Number(match[1]) - 1;
		output.push(...sourceLines.slice(sourceIndex, oldStart));
		sourceIndex = oldStart;
		index += 1;
		while (index < patch.length && !(patch[index] ?? "").startsWith("@@ ")) {
			const line = patch[index] ?? "";
			if (line.startsWith(" ")) {
				expect(sourceLines[sourceIndex]).toBe(line.slice(1));
				output.push(line.slice(1));
				sourceIndex += 1;
			} else if (line.startsWith("-")) {
				expect(sourceLines[sourceIndex]).toBe(line.slice(1));
				sourceIndex += 1;
			} else if (line.startsWith("+")) output.push(line.slice(1));
			index += 1;
		}
	}
	output.push(...sourceLines.slice(sourceIndex));
	return output.join("\n");
}

describe("deterministic complete-file validation", () => {
	it("produces a smaller, hash-linked patch that reconstructs current source exactly", async () => {
		const workspace = await createWorkspace();
		try {
			const original = Array.from({ length: 300 }, (_, index) => `stable line ${index + 1}`).join("\n");
			const current = original.replace("stable line 150", "changed line 150");
			await workspace.write("file.txt", original);
			const baseline = baselineMessage(workspace.dir, "file.txt", original, "line-numbered");
			await workspace.write("file.txt", current);
			const result = await createExploreReadTool(testRowState).execute(
				"changed",
				{ path: "file.txt" },
				undefined,
				undefined,
				branchExtensionContext(workspace.dir, [{ type: "message", message: baseline }]),
			);
			const output = firstText(result);
			expect(result.details?.readCache).toMatchObject({
				mode: "diff",
				baseHash: hash(original),
				servedHash: hash(current),
			});
			expect(result.details?.readCache?.returnedTokens).toBe(estimateTokens(output));
			expect(result.details?.readCache?.returnedTokens).toBeLessThan(estimateTokens(current));
			expect(truncateHead(output).truncated).toBe(false);
			expect(result.details?.truncation).toBeUndefined();
			expect(applyUnifiedPatch(original, output)).toBe(current);
		} finally {
			await workspace.cleanup();
		}
	});

	it("uses one canonical complete-file scope across numbered and plain reads", async () => {
		const workspace = await createWorkspace();
		try {
			const source = "one\ntwo\nthree";
			await workspace.write("file.txt", source);
			for (const presentation of ["plain", "line-numbered"] as const) {
				const message = baselineMessage(workspace.dir, "file.txt", source, presentation);
				for (const lineNumbers of [false, true]) {
					const result = await createExploreReadTool(testRowState).execute(
						`${presentation}:${lineNumbers}`,
						{ path: "file.txt", lineNumbers },
						undefined,
						undefined,
						branchExtensionContext(workspace.dir, [{ type: "message", message }]),
					);
					expect(firstText(result)).toBe("unchanged, 3 lines");
					expect(result.details?.readCache?.scopeKey).toBe("full");
				}
			}
		} finally {
			await workspace.cleanup();
		}
	});

	it("falls back to current source when the selected branch has no source or only unreconstructible metadata", async () => {
		const workspace = await createWorkspace();
		try {
			const source = "current source\nsecond line";
			await workspace.write("file.txt", source);
			const pathKey = resolve(workspace.dir, "file.txt");
			const malformed = {
				role: "toolResult",
				toolName: "read",
				content: [{ type: "text", text: "not the source" }],
				details: {
					readCache: createCompleteFileMeta({
						pathKey,
						presentation: "plain",
						servedHash: hash(source),
						mode: "baseline",
						sourceText: source,
						returnedText: "not the source",
						totalLines: 2,
						summary: "2 lines",
					}),
				},
			};
			for (const branch of [[], [{ type: "message", message: malformed }]]) {
				const result = await createExploreReadTool(testRowState).execute(
					"fallback",
					{ path: "file.txt" },
					undefined,
					undefined,
					branchExtensionContext(workspace.dir, branch),
				);
				expect(firstText(result)).toBe(source);
				expect(result.details?.readCache?.mode).toBe("baseline");
			}
		} finally {
			await workspace.cleanup();
		}
	});

	it("rejects oversized source-bearing autoreads instead of trusting only their hash", async () => {
		const workspace = await createWorkspace();
		try {
			const source = `sentinel\n${"x".repeat(1024 * 1024)}`;
			await workspace.write("large.txt", source);
			const message = baselineMessage(workspace.dir, "large.txt", source);
			const context = branchExtensionContext(workspace.dir, [{ type: "message", message }]);
			expect(createReadCacheStore().decision(context, resolve(workspace.dir, "large.txt"), "full")).toEqual({
				baseHash: undefined,
				baselineText: undefined,
				recovery: false,
			});
			const result = await createExploreReadTool(testRowState).execute(
				"large",
				{ path: "large.txt" },
				undefined,
				undefined,
				context,
			);
			expect(firstText(result)).toContain("sentinel");
			expect(result.details?.readCache?.mode).not.toBe("unchanged");
			expect(result.details?.readCache?.mode).not.toBe("diff");
		} finally {
			await workspace.cleanup();
		}
	});

	it("falls back after snapshot eviction and after a lifecycle epoch changes", async () => {
		const workspace = await createWorkspace();
		try {
			const first = Array.from({ length: 100 }, (_, index) => `line ${index + 1}`).join("\n");
			const second = first.replace("line 50", "line fifty");
			const current = second.replace("line fifty", "current line");
			await workspace.write("file.txt", current);
			const snapshots = createReadSnapshotStore();
			const epoch = snapshots.epoch();
			snapshots.set(hash(second), second, Buffer.byteLength(second), epoch);
			for (let index = 0; index < 16; index += 1) snapshots.set(`filler-${index}`, "filler", 1024 * 1024, epoch);
			const initial = baselineMessage(workspace.dir, "file.txt", first);
			const diffMeta = createCompleteFileMeta({
				pathKey: resolve(workspace.dir, "file.txt"),
				presentation: "plain",
				servedHash: hash(second),
				baseHash: hash(first),
				mode: "diff",
				sourceText: second,
				returnedText: "[prior diff]",
				totalLines: 100,
				summary: "+1 -1",
			});
			const branch = [
				{ type: "message", message: initial },
				{
					type: "message",
					message: {
						role: "toolResult",
						toolName: "read",
						content: [{ type: "text", text: "[prior diff]" }],
						details: { readCache: diffMeta },
					},
				},
			];
			const evicted = await createExploreReadTool(testRowState, undefined, snapshots).execute(
				"evicted",
				{ path: "file.txt" },
				undefined,
				undefined,
				branchExtensionContext(workspace.dir, branch),
			);
			expect(firstText(evicted)).toBe(current);
			expect(evicted.details?.readCache?.mode).toBe("baseline");

			const staleSnapshots: ReadSnapshotStore = {
				get: () => undefined,
				epoch: () => 1,
				isCurrent: () => false,
				set: () => false,
				clear() {},
			};
			const stale = await createExploreReadTool(testRowState, undefined, staleSnapshots).execute(
				"stale",
				{ path: "file.txt" },
				undefined,
				undefined,
				branchExtensionContext(workspace.dir, [
					{ type: "message", message: baselineMessage(workspace.dir, "file.txt", current) },
				]),
			);
			expect(firstText(stale)).toBe(current);
			expect(stale.details?.readCache?.mode).toBe("baseline");
		} finally {
			await workspace.cleanup();
		}
	});

	it("does not return cache modes for invalid UTF-8 current source", async () => {
		const workspace = await createWorkspace();
		try {
			await writeFile(workspace.path("binary.dat"), Buffer.from([0xc3, 0x28]));
			const result = await createExploreReadTool(testRowState).execute(
				"binary",
				{ path: "binary.dat" },
				undefined,
				undefined,
				branchExtensionContext(workspace.dir, []),
			);
			expect(result.details?.readCache).toBeUndefined();
		} finally {
			await workspace.cleanup();
		}
	});

	it("uses full source when a diff is larger than full output or exceeds output limits", () => {
		const small = selectCompleteFileResponse({
			displayPath: "tiny.txt",
			currentText: "new",
			currentHash: hash("new"),
			fullText: "new",
			totalLines: 1,
			recovery: false,
			baseHash: hash("old"),
			baselineText: "old",
		});
		expect(small).toMatchObject({ text: "new", mode: "baseline" });

		const oldLines = Array.from({ length: 20_000 }, (_, index) => `old-${index}-${"a".repeat(100)}`).join("\n");
		const newLines = Array.from({ length: 20_000 }, (_, index) =>
			index % 100 === 0 ? `new-${index}-${"b".repeat(100)}` : `old-${index}-${"a".repeat(100)}`,
		).join("\n");
		const oversizedPatch = generateUnifiedPatch("large.txt", oldLines, newLines, 3);
		expect(truncateHead(oversizedPatch).truncated).toBe(true);
		expect(estimateTokens(oversizedPatch)).toBeLessThan(estimateTokens(newLines));
		const limited = selectCompleteFileResponse({
			displayPath: "large.txt",
			currentText: newLines,
			currentHash: hash(newLines),
			fullText: newLines,
			totalLines: 20_000,
			recovery: false,
			baseHash: hash(oldLines),
			baselineText: oldLines,
		});
		expect(limited).toMatchObject({ text: newLines, mode: "baseline" });
	});
});
