import { fauxAssistantMessage, fauxToolCall, type ToolResultMessage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
	parseContextPruneDetailsV2,
	replayContextPruningState,
	setContextPruningEnabled,
	type ContextPruneDetailsV2,
} from "../../shared/context-pruning-state.ts";

function details(anchorToolCallId: string, retainedToolCallIds: string[] = []): ContextPruneDetailsV2 {
	return {
		v: 2,
		anchorToolCallId,
		prunedToolCallIds: [`pruned-${anchorToolCallId}`],
		prunedAutoreadRowIds: [],
		retainedToolCallIds,
		retainedAutoreadRowIds: [],
		refreshedFiles: [],
		deferredFiles: [],
		warnings: [],
	};
}

function result(toolCallId: string, value: unknown): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "context_prune",
		content: [{ type: "text", text: "done" }],
		isError: false,
		timestamp: 1,
		details: value,
	};
}

function appendCheckpoint(manager: SessionManager, id: string, value: unknown): string {
	manager.appendMessage(fauxAssistantMessage(fauxToolCall("context_prune", {}, { id })));
	return manager.appendMessage(result(id, value));
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

	it("parses V2 checkpoint details and rejects malformed selection arrays", () => {
		const valid = details("anchor", ["keep"]);
		expect(parseContextPruneDetailsV2(valid)).toEqual(valid);
		expect(parseContextPruneDetailsV2({ ...valid, retainedToolCallIds: ["keep", "keep"] })).toBeUndefined();
		expect(parseContextPruneDetailsV2({ ...valid, warnings: [1] })).toBeUndefined();
		expect(
			parseContextPruneDetailsV2({
				...valid,
				retainedToolCallIds: [""],
				deferredFiles: [{ path: "", reason: "", relevantWhen: "" }],
			}),
		).toBeDefined();
	});

	it("uses the latest checkpoint intent while accumulating pruned row state", () => {
		const manager = SessionManager.inMemory("/tmp/context-pruning-state");
		const first = details("anchor-1", ["keep-1"]);
		first.prunedAutoreadRowIds.push("autoread-1");
		appendCheckpoint(manager, "anchor-1", first);
		const second = details("anchor-2", ["keep-2"]);
		second.deferredFiles.push({ path: "later.ts", reason: "cold", relevantWhen: "tests fail" });
		appendCheckpoint(manager, "anchor-2", second);
		appendCheckpoint(manager, "bad", { ...details("other"), anchorToolCallId: "other" });

		const state = replayContextPruningState(manager.getBranch(), true);
		expect(state.latestAnchorToolCallId).toBe("anchor-2");
		expect([...state.retainedToolCallIds]).toEqual(["keep-2"]);
		expect([...state.prunedToolCallIds]).toEqual(["pruned-anchor-1", "pruned-anchor-2"]);
		expect([...state.prunedAutoreadRowIds]).toEqual(["autoread-1"]);
		expect(state.deferredFiles).toEqual([{ path: "later.ts", reason: "cold", relevantWhen: "tests fail" }]);
	});

	it("follows the active branch and honors the runtime gate", () => {
		const manager = SessionManager.inMemory("/tmp/context-pruning-branch");
		const before = appendCheckpoint(manager, "anchor-1", details("anchor-1"));
		appendCheckpoint(manager, "anchor-2", details("anchor-2"));
		expect(replayContextPruningState(manager.getBranch(), true).latestAnchorToolCallId).toBe("anchor-2");
		manager.branch(before);
		expect(replayContextPruningState(manager.getBranch(), true).latestAnchorToolCallId).toBe("anchor-1");
		expect(replayContextPruningState(manager.getBranch(), false).latestAnchorToolCallId).toBeUndefined();
	});
});
