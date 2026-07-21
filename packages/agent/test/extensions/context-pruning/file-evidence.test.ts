import { createHash } from "node:crypto";
import { rm, symlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fauxAssistantMessage, fauxToolCall, type ToolResultMessage } from "@earendil-works/pi-ai";
import { generateUnifiedPatch } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { canonicalizeFileSelections, selectFileEvidence } from "../../../extensions/context-pruning/file-evidence.ts";
import { prepareAutoreadMessage } from "../../../extensions/explore/autoread.ts";
import {
	createCompleteFileMeta,
	MAX_COMPLETE_FILE_SNAPSHOT_BYTES,
} from "../../../extensions/explore/full-file-knowledge.ts";
import { createWorkspace } from "../explore/helpers.ts";

async function baseline(cwd: string, path: string, rowId = "read-row") {
	const prepared = await prepareAutoreadMessage({
		rowId,
		path,
		cwd,
		source: "explore",
		batchId: "batch",
		signal: undefined,
		isLifecycleCurrent: () => true,
	});
	return { role: "custom" as const, ...prepared, timestamp: 1 };
}

function hash(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

function diffEvidence(
	cwd: string,
	path: string,
	rowId: string,
	before: string,
	after: string,
	patchPath = path,
	argumentsValue: Record<string, unknown> = { path },
): [ReturnType<typeof fauxAssistantMessage>, ToolResultMessage] {
	const content = `[read: 1 lines added, 1 removed of ${after.split("\n").length}]\n${generateUnifiedPatch(patchPath, before, after, 3)}`;
	const result: ToolResultMessage = {
		role: "toolResult" as const,
		toolCallId: rowId,
		toolName: "read",
		content: [{ type: "text" as const, text: content }],
		isError: false,
		timestamp: 1,
		details: {
			readCache: createCompleteFileMeta({
				pathKey: resolve(cwd, path),
				presentation: "plain",
				servedHash: hash(after),
				baseHash: hash(before),
				mode: "diff",
				sourceText: after,
				returnedText: content,
				totalLines: after.split("\n").length,
				summary: "+1 -1",
			}),
		},
	};
	return [fauxAssistantMessage(fauxToolCall("read", argumentsValue, { id: rowId })), result];
}

function toolBaseline(
	cwd: string,
	path: string,
	rowId: string,
	source: string,
): [ReturnType<typeof fauxAssistantMessage>, ToolResultMessage] {
	const result: ToolResultMessage = {
		role: "toolResult" as const,
		toolCallId: rowId,
		toolName: "read",
		content: [{ type: "text" as const, text: source }],
		isError: false,
		timestamp: 1,
		details: {
			readCache: createCompleteFileMeta({
				pathKey: resolve(cwd, path),
				presentation: "plain",
				servedHash: hash(source),
				mode: "baseline",
				sourceText: source,
				returnedText: source,
				totalLines: source.split("\n").length,
				summary: "baseline",
			}),
		},
	};
	return [fauxAssistantMessage(fauxToolCall("read", {}, { id: rowId })), result];
}

describe("context prune file evidence", () => {
	it("keeps existing and missing in-cwd selections relative when cwd is a symlink", async () => {
		const workspace = await createWorkspace();
		const alias = `${workspace.dir}-alias`;
		try {
			await workspace.write("existing.ts", "source");
			await symlink(workspace.dir, alias, "dir");
			const canonical = await canonicalizeFileSelections({
				cwd: alias,
				keepFiles: [{ path: "existing.ts", relevance: "active" }],
				deferFiles: [{ path: "later.ts", reason: "cold", relevantWhen: "fallback fails" }],
			});
			expect(canonical.keepFiles[0]?.displayPath).toBe("existing.ts");
			expect(canonical.deferFiles[0]?.displayPath).toBe("later.ts");
		} finally {
			await rm(alias, { force: true });
			await workspace.cleanup();
		}
	});

	it("keeps an unchanged source-bearing baseline in place", async () => {
		const workspace = await createWorkspace();
		try {
			await workspace.write("file.ts", "export const value = 1;\n");
			const message = await baseline(workspace.dir, "file.ts");
			const canonical = await canonicalizeFileSelections({
				cwd: workspace.dir,
				keepFiles: [{ path: "file.ts", relevance: "active implementation" }],
				deferFiles: [],
			});
			const selection = await selectFileEvidence({
				cwd: workspace.dir,
				messages: [message],
				files: canonical.keepFiles,
				anchorToolCallId: "anchor",
				signal: undefined,
				isLifecycleCurrent: () => true,
			});
			expect([...selection.retainedAutoreadRowIds]).toEqual(["read-row"]);
			expect(selection.preparedSnapshots).toEqual([]);
			expect(selection.refreshedFiles).toEqual([]);
		} finally {
			await workspace.cleanup();
		}
	});

	it("replaces stale evidence with one deterministic fresh snapshot", async () => {
		const workspace = await createWorkspace();
		try {
			await workspace.write("file.ts", "old source\n");
			const message = await baseline(workspace.dir, "file.ts");
			await workspace.write("file.ts", "new source\n");
			const canonical = await canonicalizeFileSelections({
				cwd: workspace.dir,
				keepFiles: [{ path: "file.ts", relevance: "current source" }],
				deferFiles: [],
			});
			const selection = await selectFileEvidence({
				cwd: workspace.dir,
				messages: [message],
				files: canonical.keepFiles,
				anchorToolCallId: "anchor",
				signal: undefined,
				isLifecycleCurrent: () => true,
			});
			expect(selection.preparedSnapshots).toHaveLength(1);
			expect(selection.preparedSnapshots[0]?.details.rowId).toBe("anchor:0");
			expect([...selection.retainedAutoreadRowIds]).toEqual(["anchor:0"]);
			expect(selection.refreshedFiles[0]).toMatchObject({ path: "file.ts", rowId: "anchor:0" });
		} finally {
			await workspace.cleanup();
		}
	});

	it("keeps a valid cheap diff chain and refreshes expensive or broken chains", async () => {
		const workspace = await createWorkspace();
		try {
			const longPath = `${"long-".repeat(35)}file.ts`;
			const before = "old";
			const after = "new";
			await workspace.write(longPath, after);
			const source = toolBaseline(workspace.dir, longPath, "baseline", before);
			const diff = diffEvidence(workspace.dir, longPath, "diff", before, after, "f", {});
			const canonical = await canonicalizeFileSelections({
				cwd: workspace.dir,
				keepFiles: [{ path: longPath, relevance: "active" }],
				deferFiles: [],
			});
			const cheap = await selectFileEvidence({
				cwd: workspace.dir,
				messages: [...source, ...diff],
				files: canonical.keepFiles,
				anchorToolCallId: "anchor",
				signal: undefined,
				isLifecycleCurrent: () => true,
			});
			expect([...cheap.retainedAutoreadRowIds]).toEqual([]);
			expect([...cheap.retainedToolCallIds]).toEqual(["baseline", "diff"]);
			expect(cheap.preparedSnapshots).toEqual([]);

			const expensiveBefore = Array.from({ length: 200 }, (_, index) => `line ${index + 1}`).join("\n");
			const expensiveAfter = expensiveBefore.replace("line 100", "line one hundred");
			await workspace.write("expensive.ts", expensiveBefore);
			const expensiveSource = await baseline(workspace.dir, "expensive.ts", "expensive-baseline");
			const expensiveDiff = diffEvidence(
				workspace.dir,
				"expensive.ts",
				"expensive-diff",
				expensiveBefore,
				expensiveAfter,
			);
			await workspace.write("expensive.ts", expensiveAfter);
			const expensiveCanonical = await canonicalizeFileSelections({
				cwd: workspace.dir,
				keepFiles: [{ path: "expensive.ts", relevance: "active" }],
				deferFiles: [],
			});
			const expensive = await selectFileEvidence({
				cwd: workspace.dir,
				messages: [expensiveSource, ...expensiveDiff],
				files: expensiveCanonical.keepFiles,
				anchorToolCallId: "expensive-anchor",
				signal: undefined,
				isLifecycleCurrent: () => true,
			});
			expect(expensive.preparedSnapshots).toHaveLength(1);
			expect([...expensive.retainedAutoreadRowIds]).toEqual(["expensive-anchor:0"]);

			await workspace.write("broken.ts", before);
			const brokenSource = await baseline(workspace.dir, "broken.ts", "broken-baseline");
			const brokenDiff = diffEvidence(workspace.dir, "broken.ts", "broken-diff", before, after);
			await workspace.write("broken.ts", after);
			const brokenResult = {
				...brokenDiff[1],
				content: [{ type: "text" as const, text: "[read: 1 lines added, 1 removed of 1]\nnot a patch" }],
			};
			const brokenCanonical = await canonicalizeFileSelections({
				cwd: workspace.dir,
				keepFiles: [{ path: "broken.ts", relevance: "active" }],
				deferFiles: [],
			});
			const refreshed = await selectFileEvidence({
				cwd: workspace.dir,
				messages: [brokenSource, brokenDiff[0], brokenResult],
				files: brokenCanonical.keepFiles,
				anchorToolCallId: "anchor",
				signal: undefined,
				isLifecycleCurrent: () => true,
			});
			expect(refreshed.preparedSnapshots).toHaveLength(1);
			expect(refreshed.preparedSnapshots[0]?.details.rowId).toBe("anchor:0");
			expect([...refreshed.retainedToolCallIds]).toEqual([]);
			expect([...refreshed.retainedAutoreadRowIds]).toEqual(["anchor:0"]);
		} finally {
			await workspace.cleanup();
		}
	});

	it("rejects partial-only, invalid UTF-8, and oversized refreshes", async () => {
		const workspace = await createWorkspace();
		try {
			await workspace.write("partial.ts", "source");
			const partial = {
				role: "toolResult" as const,
				toolCallId: "partial",
				toolName: "read",
				content: [{ type: "text" as const, text: "source" }],
				isError: false,
				timestamp: 1,
				details: {
					readCache: {
						v: 1,
						pathKey: workspace.path("partial.ts"),
						scopeKey: "r:1:1:n0",
						presentation: "plain",
						servedHash: "hash",
						mode: "baseline",
						baselineTokens: 1,
						returnedTokens: 1,
						totalLines: 1,
						summary: "1 line",
					},
				},
			};
			const partialCanonical = await canonicalizeFileSelections({
				cwd: workspace.dir,
				keepFiles: [{ path: "partial.ts", relevance: "needed" }],
				deferFiles: [],
			});
			await expect(
				selectFileEvidence({
					cwd: workspace.dir,
					messages: [partial],
					files: partialCanonical.keepFiles,
					anchorToolCallId: "anchor",
					signal: undefined,
					isLifecycleCurrent: () => true,
				}),
			).rejects.toThrow("only partial read evidence");

			await workspace.write("invalid.bin", "valid");
			const invalidBaseline = await baseline(workspace.dir, "invalid.bin");
			await writeFile(workspace.path("invalid.bin"), Buffer.from([0xc3, 0x28]));
			const invalidCanonical = await canonicalizeFileSelections({
				cwd: workspace.dir,
				keepFiles: [{ path: "invalid.bin", relevance: "needed" }],
				deferFiles: [],
			});
			await expect(
				selectFileEvidence({
					cwd: workspace.dir,
					messages: [invalidBaseline],
					files: invalidCanonical.keepFiles,
					anchorToolCallId: "anchor",
					signal: undefined,
					isLifecycleCurrent: () => true,
				}),
			).rejects.toThrow();
			await workspace.write("large.txt", "old");
			const largeBaseline = await baseline(workspace.dir, "large.txt");
			await writeFile(workspace.path("large.txt"), Buffer.alloc(MAX_COMPLETE_FILE_SNAPSHOT_BYTES + 1, 97));
			const largeCanonical = await canonicalizeFileSelections({
				cwd: workspace.dir,
				keepFiles: [{ path: "large.txt", relevance: "needed" }],
				deferFiles: [],
			});
			await expect(
				selectFileEvidence({
					cwd: workspace.dir,
					messages: [largeBaseline],
					files: largeCanonical.keepFiles,
					anchorToolCallId: "anchor",
					signal: undefined,
					isLifecycleCurrent: () => true,
				}),
			).rejects.toThrow("snapshot limit");
		} finally {
			await workspace.cleanup();
		}
	});

	it("deduplicates canonical aliases across keep and defer selections", async () => {
		const workspace = await createWorkspace();
		try {
			await workspace.write("real.ts", "source");
			await symlink(workspace.path("real.ts"), workspace.path("alias.ts"));
			await expect(
				canonicalizeFileSelections({
					cwd: workspace.dir,
					keepFiles: [{ path: "real.ts", relevance: "needed" }],
					deferFiles: [{ path: "alias.ts", reason: "later", relevantWhen: "condition" }],
				}),
			).rejects.toThrow("Duplicate file selection");
		} finally {
			await workspace.cleanup();
		}
	});
});
