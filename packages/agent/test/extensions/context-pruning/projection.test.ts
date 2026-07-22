import {
	fauxAssistantMessage,
	fauxText,
	fauxThinking,
	fauxToolCall,
	type ToolResultMessage,
} from "@earendil-works/pi-ai";
import type { ContextEvent } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { projectContext } from "../../../extensions/context-pruning/projection.ts";
import type { ActiveContextPruningState } from "../../../shared/context-pruning-state.ts";

type Message = ContextEvent["messages"][number];

function result(id: string, name: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: name,
		content: [{ type: "text", text: `${name} result` }],
		isError: false,
		timestamp: 1,
	};
}

function custom(customType: string, content: string): Message {
	return { role: "custom", customType, content, display: false, timestamp: 1 };
}

function state(pruned: string[], prunedAutoreads: string[] = []): ActiveContextPruningState {
	return {
		latestAnchorToolCallId: "anchor",
		prunedToolCallIds: new Set(pruned),
		prunedAutoreadRowIds: new Set(prunedAutoreads),
		deferredFiles: [],
	};
}

describe("context pruning projection", () => {
	it("filters pre-anchor thinking and one parallel exchange while preserving untouched identity and post-anchor evidence", () => {
		const keptCall = fauxToolCall("read", { path: "keep.ts" }, { id: "keep" });
		const droppedCall = fauxToolCall("grep", { query: "old" }, { id: "drop" });
		const pre = fauxAssistantMessage([
			fauxThinking("old reasoning"),
			fauxText("visible conclusion"),
			keptCall,
			droppedCall,
		]);
		const keptResult = result("keep", "read");
		const droppedResult = result("drop", "grep");
		const anchor = fauxAssistantMessage([
			fauxThinking("anchor reasoning"),
			fauxText("next action"),
			fauxToolCall("context_prune", {}, { id: "anchor" }),
		]);
		const anchorResult = result("anchor", "context_prune");
		const currentDeferred = custom("tau.context-pruning.deferred", "current");
		const oldAutoread = {
			...custom("tau.autoread", "old snapshot"),
			details: { rowId: "old-autoread" },
		} as Message;
		const post = fauxAssistantMessage([
			fauxThinking("new reasoning"),
			fauxToolCall("read", { path: "new.ts" }, { id: "post" }),
		]);
		const postResult = result("post", "read");
		const unknown = custom("unknown.extension", "keep me");
		const messages: Message[] = [
			{ role: "user", content: "work", timestamp: 1 },
			custom("tau.context-pruning.nudge", "old"),
			custom("tau.context-pruning.deferred", "superseded"),
			oldAutoread,
			pre,
			keptResult,
			droppedResult,
			anchor,
			anchorResult,
			currentDeferred,
			post,
			postResult,
			unknown,
		];

		const projected = projectContext(messages, state(["drop"], ["old-autoread"]));
		expect(projected.map((message) => message.role)).toEqual([
			"user",
			"assistant",
			"toolResult",
			"assistant",
			"toolResult",
			"custom",
			"assistant",
			"toolResult",
			"custom",
		]);
		const projectedPre = projected[1];
		expect(projectedPre?.role).toBe("assistant");
		if (projectedPre?.role !== "assistant") throw new Error("expected assistant");
		expect(projectedPre.content).toEqual([pre.content[1], keptCall]);
		expect(projectedPre.content[0]).toBe(pre.content[1]);
		expect(projected[2]).toBe(keptResult);
		expect(projected[4]).toBe(anchorResult);
		expect(projected[5]).toBe(currentDeferred);
		expect(projected[6]).toBe(post);
		expect(projected[8]).toBe(unknown);
		expect(projectContext(messages, state(["drop"], ["old-autoread"]))).toEqual(projected);
	});

	it("drops an assistant message made empty by filtering and rejects orphaned output", () => {
		const empty = fauxAssistantMessage([fauxThinking("discard"), fauxToolCall("read", {}, { id: "drop" })]);
		const anchor = fauxAssistantMessage(fauxToolCall("context_prune", {}, { id: "anchor" }));
		const projected = projectContext(
			[empty, result("drop", "read"), anchor, result("anchor", "context_prune")],
			state(["drop"]),
		);
		expect(projected).toEqual([anchor, result("anchor", "context_prune")]);
		expect(() => projectContext([result("orphan", "read")], state([]))).toThrow(/Orphaned tool result/);
	});

	it("drops an unmatched tool call from an aborted assistant response", () => {
		const abandoned = fauxAssistantMessage(fauxToolCall("bash", { command: "blocked" }, { id: "abandoned" }), {
			stopReason: "aborted",
			errorMessage: "Operation aborted",
		});
		const ordinary = fauxAssistantMessage(fauxToolCall("bash", { command: "blocked" }, { id: "ordinary" }));
		const anchor = fauxAssistantMessage(fauxToolCall("context_prune", {}, { id: "anchor" }));
		const anchorResult = result("anchor", "context_prune");

		expect(projectContext([abandoned, anchor, anchorResult], state([]))).toEqual([anchor, anchorResult]);
		expect(() => projectContext([ordinary, anchor, anchorResult], state([]))).toThrow(/Orphaned tool call.*ordinary/);
	});

	it("preserves user bash, branch summary, compaction summary, and unknown custom messages", () => {
		const preserved: Message[] = [
			{ role: "user", content: "keep", timestamp: 1 },
			{
				role: "bashExecution",
				command: "pwd",
				output: "/tmp",
				exitCode: 0,
				cancelled: false,
				truncated: false,
				timestamp: 1,
			},
			{ role: "branchSummary", summary: "branch", fromId: "entry", timestamp: 1 },
			{ role: "compactionSummary", summary: "compact", tokensBefore: 10, timestamp: 1 },
			custom("unknown.before-anchor", "keep"),
		];
		const anchor = fauxAssistantMessage(fauxToolCall("context_prune", {}, { id: "anchor" }));
		const anchorResult = result("anchor", "context_prune");
		const projected = projectContext([...preserved, anchor, anchorResult], state([]));
		expect(projected.slice(0, preserved.length)).toEqual(preserved);
		for (let index = 0; index < preserved.length; index += 1) expect(projected[index]).toBe(preserved[index]);
	});
});
