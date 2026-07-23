import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fauxAssistantMessage, fauxToolCall, type ToolResultMessage } from "@earendil-works/pi-ai";
import { generateUnifiedPatch, SessionManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { createCompleteFileMeta } from "../../../extensions/explore/full-file-knowledge.ts";
import { createReadCacheStore, replayReadCache } from "../../../extensions/explore/read-cache.ts";
import { setContextPruningEnabled, type ContextPruneDetailsV2 } from "../../../shared/context-pruning-state.ts";

function hash(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

function readEntry(options: {
	rowId: string;
	pathKey: string;
	content: string;
	servedText: string;
	servedHash?: string;
	mode: "baseline" | "diff";
	baseHash?: string;
}) {
	return {
		type: "message",
		message: {
			role: "toolResult",
			toolName: "read",
			toolCallId: options.rowId,
			content: [{ type: "text", text: options.content }],
			details: {
				readCache: createCompleteFileMeta({
					pathKey: options.pathKey,
					presentation: "plain",
					servedHash: options.servedHash ?? hash(options.servedText),
					mode: options.mode,
					sourceText: options.servedText,
					returnedText: options.content,
					totalLines: options.servedText.split("\n").length,
					summary: options.mode === "baseline" ? "baseline" : "+1 -1",
					baseHash: options.baseHash,
				}),
			},
		},
	};
}

function autoreadEntry(cwd: string, path: string, rowId: string, source: string) {
	const content = `${path}\n${source}`;
	return {
		type: "custom_message",
		customType: "tau.autoread",
		content,
		details: {
			rowId,
			path,
			cwd,
			status: "read",
			readCache: createCompleteFileMeta({
				pathKey: resolve(cwd, path),
				presentation: "plain",
				servedHash: hash(source),
				mode: "baseline",
				sourceText: source,
				returnedText: content,
				totalLines: source.split("\n").length,
				summary: "baseline",
			}),
		},
	};
}

describe("read-cache replay", () => {
	it("prunes and restores trust from the real active session branch", () => {
		const cwd = "/workspace";
		const path = "file.txt";
		const source = "current source";
		const manager = SessionManager.inMemory(cwd);
		const pathKey = resolve(cwd, path);
		manager.appendMessage(fauxAssistantMessage(fauxToolCall("read", { path }, { id: "read-row" })));
		const readEntryId = manager.appendMessage({
			role: "toolResult",
			toolName: "read",
			toolCallId: "read-row",
			content: [{ type: "text", text: source }],
			isError: false,
			timestamp: 1,
			details: {
				readCache: createCompleteFileMeta({
					pathKey,
					presentation: "plain",
					servedHash: hash(source),
					mode: "baseline",
					sourceText: source,
					returnedText: source,
					totalLines: 1,
					summary: "baseline",
				}),
			},
		});
		const context = { cwd, sessionManager: manager } as unknown as ExtensionContext;
		const cache = createReadCacheStore();
		setContextPruningEnabled(true);
		try {
			expect(cache.decision(context, pathKey, "full")).toMatchObject({
				baseHash: hash(source),
				baselineText: source,
			});
			manager.appendMessage(fauxAssistantMessage(fauxToolCall("context_prune", {}, { id: "anchor" })));
			const details: ContextPruneDetailsV2 = {
				v: 2,
				anchorToolCallId: "anchor",
				prunedToolCallIds: ["read-row"],
				prunedAutoreadRowIds: [],
				retainedToolCallIds: [],
				retainedAutoreadRowIds: [],
				refreshedFiles: [],
				deferredFiles: [],
				warnings: [],
			};
			const result: ToolResultMessage = {
				role: "toolResult",
				toolCallId: "anchor",
				toolName: "context_prune",
				content: [{ type: "text", text: "done" }],
				isError: false,
				timestamp: 1,
				details,
			};
			manager.appendMessage(result);
			expect(cache.decision(context, pathKey, "full")).toEqual({
				baseHash: undefined,
				baselineText: undefined,
				recovery: false,
			});

			manager.branch(readEntryId);
			expect(cache.decision(context, pathKey, "full")).toMatchObject({
				baseHash: hash(source),
				baselineText: source,
			});
		} finally {
			setContextPruningEnabled(false);
		}
	});

	it("ignores pruned read and autoread rows while replaying retained evidence", () => {
		const cwd = "/workspace";
		const retained = autoreadEntry(cwd, "retained.txt", "retained", "retained source");
		const pruned = autoreadEntry(cwd, "pruned.txt", "pruned", "pruned source");
		const replay = replayReadCache([retained, pruned], cwd, new Set(["pruned"]));
		expect(replay.acceptedRows.map((row) => row.rowId)).toEqual(["retained"]);
		expect(replay.completeFileChains.has(resolve(cwd, "retained.txt"))).toBe(true);
		expect(replay.completeFileChains.has(resolve(cwd, "pruned.txt"))).toBe(false);
	});

	it("replays a checkpoint file directly from its atomic tool result", () => {
		const cwd = "/workspace";
		const snapshot = autoreadEntry(cwd, "retained.txt", "anchor:0", "retained source");
		const replay = replayReadCache(
			[
				{
					type: "message",
					message: {
						role: "toolResult",
						toolName: "context_prune",
						toolCallId: "anchor",
						content: [{ type: "text", text: "checkpoint applied" }, { type: "text", text: snapshot.content }],
						details: {
							v: 2,
							refreshedFiles: [
								{
									path: "retained.txt",
									rowId: "anchor:0",
									servedHash: hash("retained source"),
									autoreadDetails: snapshot.details,
								},
							],
						},
					},
				},
			],
			cwd,
		);

		expect(replay.completeFileChains.get(resolve(cwd, "retained.txt"))).toMatchObject({
			servedHash: hash("retained source"),
			rowIds: ["anchor:0"],
			sourceText: "retained source",
		});
	});

	it("returns accepted rows and a reconstructible complete-file dependency chain", () => {
		const cwd = "/workspace";
		const pathKey = resolve(cwd, "file.txt");
		const baseline = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n");
		const changed = baseline.replace("line 10", "line ten");
		const final = changed.replace("line 15", "line fifteen");
		const diff = `[read: 1 lines added, 1 removed of 20]\n${generateUnifiedPatch("file.txt", baseline, changed, 3)}`;
		const secondDiff = `[read: 1 lines added, 1 removed of 20]\n${generateUnifiedPatch("file.txt", changed, final, 3)}`;
		const replay = replayReadCache(
			[
				autoreadEntry(cwd, "file.txt", "baseline", baseline),
				readEntry({
					rowId: "diff",
					pathKey,
					content: diff,
					servedText: changed,
					mode: "diff",
					baseHash: hash(baseline),
				}),
				readEntry({
					rowId: "second-diff",
					pathKey,
					content: secondDiff,
					servedText: final,
					mode: "diff",
					baseHash: hash(changed),
				}),
			],
			cwd,
		);

		expect(
			replay.acceptedRows.map(({ rowId, pathKey: acceptedPath, dependencyRowIds }) => [
				rowId,
				acceptedPath,
				dependencyRowIds,
			]),
		).toEqual([
			["baseline", pathKey, ["baseline"]],
			["diff", pathKey, ["baseline", "diff"]],
			["second-diff", pathKey, ["baseline", "diff", "second-diff"]],
		]);
		expect(replay.completeFileChains.get(pathKey)).toEqual({
			pathKey,
			servedHash: hash(final),
			rowIds: ["baseline", "diff", "second-diff"],
			sourceText: final,
		});
	});

	it("rejects broken content and invalid base or served hashes", () => {
		const cwd = "/workspace";
		const pathKey = resolve(cwd, "file.txt");
		const baseline = "one\ntwo\nthree";
		const changed = "one\nchanged\nthree";
		const validDiff = `[read: 1 lines added, 1 removed of 3]\n${generateUnifiedPatch("file.txt", baseline, changed, 3)}`;
		const replay = replayReadCache(
			[
				readEntry({
					rowId: "baseline",
					pathKey,
					content: baseline,
					servedText: baseline,
					mode: "baseline",
				}),
				readEntry({
					rowId: "broken",
					pathKey,
					content: "[read: 1 lines added, 1 removed of 3]\nnot a unified diff",
					servedText: changed,
					mode: "diff",
					baseHash: hash(baseline),
				}),
				readEntry({
					rowId: "wrong-base",
					pathKey,
					content: validDiff,
					servedText: changed,
					mode: "diff",
					baseHash: hash("not the baseline"),
				}),
				readEntry({
					rowId: "wrong-served",
					pathKey,
					content: validDiff,
					servedText: changed,
					servedHash: hash("not the served source"),
					mode: "diff",
					baseHash: hash(baseline),
				}),
			],
			cwd,
		);

		expect(replay.acceptedRows.map(({ rowId }) => rowId)).toEqual(["baseline"]);
		expect(replay.completeFileChains.get(pathKey)).toMatchObject({
			servedHash: hash(baseline),
			rowIds: ["baseline"],
			sourceText: baseline,
		});
	});

	it("reports failed-patch recovery separately from accepted read evidence", () => {
		const cwd = "/workspace";
		const pathKey = resolve(cwd, "file.txt");
		const replay = replayReadCache(
			[
				{
					type: "message",
					message: {
						role: "toolResult",
						toolName: "patch",
						details: { status: "failed", failures: [{ path: "file.txt" }] },
					},
				},
			],
			cwd,
		);

		expect(replay.acceptedRows).toEqual([]);
		expect(replay.completeFileChains.size).toBe(0);
		expect([...replay.failedPatchRecoveryPaths]).toEqual([pathKey]);
	});
});
