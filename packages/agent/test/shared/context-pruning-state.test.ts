import { fauxAssistantMessage, fauxToolCall, type ToolResultMessage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
	parseContextPruneDetailsV1,
	replayContextPruningState,
	setContextPruningEnabled,
	type ContextPruneDetailsV1,
} from "../../shared/context-pruning-state.ts";

function details(
	anchorToolCallId: string,
	newlyPrunedToolCallIds: string[] = [],
	deferredFiles: ContextPruneDetailsV1["deferredFiles"] = [],
): ContextPruneDetailsV1 {
	return {
		v: 1,
		status: "applied",
		anchorToolCallId,
		newlyPrunedToolCallIds,
		newlyPrunedAutoreadRowIds: [],
		retainedToolCallIds: [],
		retainedAutoreadRowIds: [],
		refreshedFiles: [],
		deferredFiles,
		tokensBefore: 100,
		tokensAfter: 40,
		tokensReclaimed: 60,
	};
}

function result(toolCallId: string, toolName: string, value?: unknown): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text: "done" }],
		isError: false,
		timestamp: Date.now(),
		...(value === undefined ? {} : { details: value }),
	};
}

function appendExchange(manager: SessionManager, id: string, name: string, value?: unknown): string {
	manager.appendMessage(fauxAssistantMessage(fauxToolCall(name, {}, { id })));
	return manager.appendMessage(result(id, name, value));
}

describe("context pruning persisted state", () => {
	it("shares the runtime gate across isolated extension module loaders", () => {
		const key = Symbol.for("@earendil-works/tau-agent/context-pruning-enabled");
		const runtime = globalThis as typeof globalThis & { [key: symbol]: unknown };
		try {
			setContextPruningEnabled(true);
			expect(runtime[key]).toBe(true);
			setContextPruningEnabled(false);
			expect(runtime[key]).toBe(false);
		} finally {
			setContextPruningEnabled(false);
		}
	});

	it("strictly parses complete V1 details and rejects a malformed record as a whole", () => {
		const valid = details("anchor");
		expect(parseContextPruneDetailsV1(valid)).toEqual(valid);
		expect(parseContextPruneDetailsV1({ ...valid, extra: true })).toBeUndefined();
		expect(parseContextPruneDetailsV1({ ...valid, tokensAfter: -1 })).toBeUndefined();
		expect(parseContextPruneDetailsV1({ ...valid, deferredFiles: [{ path: "a", reason: "old" }] })).toBeUndefined();
	});

	it("replays cumulative applied records and ignores records with missing branch references", () => {
		const manager = SessionManager.inMemory("/tmp/context-pruning-state");
		appendExchange(manager, "read-1", "read");
		manager.appendCustomMessageEntry("tau.autoread", "old.ts\nsource", true, {
			rowId: "autoread-1",
			path: "old.ts",
			cwd: "/tmp/context-pruning-state",
			source: "explore",
			batchId: "read-batch",
			status: "read",
			readCache: { servedHash: "hash-1" },
		});
		const firstDetails = details("anchor-1", ["read-1"]);
		firstDetails.newlyPrunedAutoreadRowIds.push("autoread-1");
		appendExchange(manager, "anchor-1", "context_prune", firstDetails);
		appendExchange(manager, "read-2", "read");
		appendExchange(
			manager,
			"anchor-2",
			"context_prune",
			details("anchor-2", ["read-2"], [{ path: "later.ts", reason: "cold", relevantWhen: "tests fail" }]),
		);
		appendExchange(manager, "bad-anchor", "context_prune", details("bad-anchor", ["missing"]));

		const state = replayContextPruningState(manager.getBranch(), true);
		expect(state.latestAnchorToolCallId).toBe("anchor-2");
		expect([...state.prunedToolCallIds]).toEqual(["read-1", "read-2"]);
		expect([...state.prunedAutoreadRowIds]).toEqual(["autoread-1"]);
		expect(state.deferredFiles).toEqual([{ path: "later.ts", reason: "cold", relevantWhen: "tests fail" }]);
	});

	it("follows the active branch and honors the runtime gate", () => {
		const manager = SessionManager.inMemory("/tmp/context-pruning-branch");
		const beforeAnchor = appendExchange(manager, "read-1", "read");
		const skipped = details("skipped-anchor");
		skipped.status = "skipped";
		appendExchange(manager, "skipped-anchor", "context_prune", skipped);
		expect(replayContextPruningState(manager.getBranch(), true).latestAnchorToolCallId).toBeUndefined();
		appendExchange(manager, "anchor-1", "context_prune", details("anchor-1", ["read-1"]));
		expect(replayContextPruningState(manager.getBranch(), true).latestAnchorToolCallId).toBe("anchor-1");
		manager.appendCompaction("summary", beforeAnchor, 100);
		expect(replayContextPruningState(manager.getBranch(), true).latestAnchorToolCallId).toBe("anchor-1");

		manager.branch(beforeAnchor);
		expect(replayContextPruningState(manager.getBranch(), true).latestAnchorToolCallId).toBeUndefined();
		expect(replayContextPruningState(manager.getBranch(), false).prunedToolCallIds.size).toBe(0);
	});
});
