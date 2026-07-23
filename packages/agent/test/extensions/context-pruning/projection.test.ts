import { fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall, type ToolResultMessage } from "@earendil-works/pi-ai";
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

function state(retainedToolCallIds: string[], anchor = "anchor"): ActiveContextPruningState {
	return {
		latestAnchorToolCallId: anchor,
		retainedToolCallIds: new Set(retainedToolCallIds),
		prunedToolCallIds: new Set(),
		prunedAutoreadRowIds: new Set(),
		deferredFiles: [],
	};
}

describe("context pruning projection", () => {
	it("turns the latest anchor into a hard checkpoint and retains one parallel exchange exactly", () => {
		const keep = fauxToolCall("read", { path: "keep.ts" }, { id: "keep" });
		const drop = fauxToolCall("read", { path: "huge.ts" }, { id: "drop" });
		const batch = fauxAssistantMessage([fauxThinking("old"), fauxText("old prose"), keep, drop]);
		const keptResult = result("keep", "read");
		const anchor = fauxAssistantMessage([
			fauxText("Durable conclusions and next action"),
			fauxToolCall("context_prune", {}, { id: "anchor" }),
		]);
		const anchorResult = result("anchor", "context_prune");
		const later = fauxAssistantMessage(fauxText("continued"));
		const messages: Message[] = [
			{ role: "user", content: "old request", timestamp: 1 },
			{ role: "custom", customType: "tau.autoread", content: "huge", display: true, timestamp: 1 },
			batch,
			keptResult,
			result("drop", "read"),
			anchor,
			anchorResult,
			later,
		];

		const projected = projectContext(messages, state(["keep"]));
		expect(projected).toHaveLength(5);
		const retainedBatch = projected[0];
		expect(retainedBatch?.role).toBe("assistant");
		if (retainedBatch?.role !== "assistant") throw new Error("expected assistant");
		expect(retainedBatch.content).toEqual([keep]);
		expect(projected[1]).toBe(keptResult);
		expect(projected.slice(2)).toEqual([anchor, anchorResult, later]);
	});

	it("drops every unreserved pre-anchor message without validating unrelated history", () => {
		const abandoned = fauxAssistantMessage(fauxToolCall("bash", {}, { id: "abandoned" }), {
			stopReason: "aborted",
		});
		const anchor = fauxAssistantMessage(fauxToolCall("context_prune", {}, { id: "anchor" }));
		const anchorResult = result("anchor", "context_prune");
		expect(
			projectContext(
				[
					{ role: "user", content: "old", timestamp: 1 },
					result("orphan", "read"),
					abandoned,
					anchor,
					anchorResult,
				],
				state([]),
			),
		).toEqual([anchor, anchorResult]);
	});

	it("harmlessly omits a selected ID without a complete matching exchange", () => {
		const incomplete = fauxAssistantMessage(fauxToolCall("read", {}, { id: "incomplete" }));
		const anchor = fauxAssistantMessage(fauxToolCall("context_prune", {}, { id: "anchor" }));
		expect(projectContext([incomplete, anchor, result("anchor", "context_prune")], state(["incomplete"]))).toEqual([
			anchor,
			result("anchor", "context_prune"),
		]);
	});

	it("leaves context untouched when the active anchor is absent", () => {
		const messages: Message[] = [{ role: "user", content: "current compacted context", timestamp: 1 }];
		const projected = projectContext(messages, state(["missing"], "missing-anchor"));
		expect(projected).toEqual(messages);
		expect(projected).not.toBe(messages);
	});
});
