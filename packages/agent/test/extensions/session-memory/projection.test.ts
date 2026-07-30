import { fauxAssistantMessage, fauxText, fauxToolCall, type ToolResultMessage } from "@earendil-works/pi-ai";
import type { ContextEvent, SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
	collectPrunedRowIds,
	projectSessionMemory,
	TASK_REMINDER_TOOL_RESULTS,
} from "../../../extensions/session-memory/projection.ts";
import {
	formatSessionMemory,
	replaySessionMemory,
	type SessionMemoryDetailsV2,
	type SessionMemoryState,
} from "../../../extensions/session-memory/state.ts";

const state: SessionMemoryState = {
	longTermGoal: "Ship session memory",
	tasks: ["Keep one canonical pair"],
	shortTermMemories: [],
	longTermMemories: [{ id: "stable-prefix", text: "Reuse checkpoint bytes and IDs." }],
	readFiles: [],
	outlineFiles: [],
	deferFiles: [],
};

function details(id: string): SessionMemoryDetailsV2 {
	return {
		v: 2,
		toolCallId: id,
		kind: "checkpoint",
		checkpoint: 1,
		state,
		changes: ["Checkpoint 1 created"],
		outlinedRows: [],
		prunedRowIds: ["old-read"],
		warnings: [],
	};
}

function result(id: string, value: SessionMemoryDetailsV2): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: "session_memory",
		content: [{ type: "text", text: formatSessionMemory(value.state, value.checkpoint, value.warnings) }],
		details: value,
		isError: false,
		timestamp: 1,
	};
}

function entry(id: string, message: ContextEvent["messages"][number]): SessionEntry {
	return { type: "message", id, parentId: null, timestamp: "2026-07-29T12:00:00.000Z", message };
}

describe("session-memory projection", () => {
	it("keeps one sanitized checkpoint pair and drops sibling calls and old context", () => {
		const checkpoint = details("checkpoint");
		const oldUser = { role: "user" as const, content: "large old context", timestamp: 1 };
		const oldRead = fauxAssistantMessage(fauxToolCall("read", { path: "old.ts" }, { id: "old-read" }));
		const anchor = fauxAssistantMessage([
			fauxText("This text leaves projected context."),
			fauxToolCall("session_memory", { action: "update", longTermGoal: "large arguments" }, { id: "checkpoint" }),
			fauxToolCall("bash", { command: "echo sibling" }, { id: "sibling" }),
		]);
		const siblingResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "sibling",
			toolName: "bash",
			content: [{ type: "text", text: "blocked" }],
			isError: true,
			timestamp: 1,
		};
		const injection: ContextEvent["messages"][number] = {
			role: "custom",
			customType: "tau.autoread",
			content: "active.ts\nsource",
			display: true,
			timestamp: 1,
		};
		const branch = [
			entry("old-user", oldUser),
			entry("old-read", oldRead),
			entry("anchor", anchor),
			entry("checkpoint-result", result("checkpoint", checkpoint)),
			entry("sibling-result", siblingResult),
		] satisfies SessionEntry[];
		const messages = [oldUser, oldRead, anchor, result("checkpoint", checkpoint), siblingResult, injection];
		const projection = projectSessionMemory(messages, replaySessionMemory(branch));
		expect(projection.projectedCheckpointId).toBe("checkpoint");
		expect(projection.messages).toHaveLength(3);
		expect(projection.messages[1]).toEqual(result("checkpoint", checkpoint));
		expect(projection.messages[2]).toEqual(injection);
		const projectedAnchor = projection.messages[0];
		if (projectedAnchor?.role !== "assistant") throw new Error("expected assistant checkpoint");
		expect(projectedAnchor.content).toHaveLength(1);
		expect(projectedAnchor.content[0]).toMatchObject({
			type: "toolCall",
			id: "checkpoint",
			name: "session_memory",
			arguments: { action: "checkpoint" },
		});
		expect(JSON.stringify(projection.messages)).not.toContain("large old context");
		expect(JSON.stringify(projection.messages)).not.toContain("sibling");
	});

	it("keeps compaction recovery stable across later ordinary updates", () => {
		const checkpoint = details("checkpoint");
		const compactedUpdate = {
			...checkpoint,
			toolCallId: "compacted-update",
			kind: "update" as const,
			state: { ...state, tasks: ["Compacted task"] },
		};
		const laterUpdate = {
			...checkpoint,
			toolCallId: "later-update",
			kind: "update" as const,
			state: { ...state, tasks: ["Later task"] },
		};
		const branch = [
			entry("checkpoint-result", result("checkpoint", checkpoint)),
			entry("compacted-update-result", result("compacted-update", compactedUpdate)),
			{
				type: "compaction",
				id: "compaction",
				parentId: null,
				timestamp: "2026-07-29T12:00:02.000Z",
				summary: "emergency summary",
				firstKeptEntryId: "later-update-result",
				tokensBefore: 150_000,
			},
			entry("later-update-result", result("later-update", laterUpdate)),
		] satisfies SessionEntry[];
		const compaction: ContextEvent["messages"][number] = {
			role: "compactionSummary",
			summary: "emergency summary",
			tokensBefore: 150_000,
			timestamp: 1,
		};
		const later = { role: "user" as const, content: "continue", timestamp: 2 };
		const first = projectSessionMemory([compaction, later], replaySessionMemory(branch));
		const second = projectSessionMemory([compaction, later], replaySessionMemory(branch));
		expect(first).toEqual(second);
		expect(first.messages[1]).toMatchObject({
			role: "custom",
			customType: "tau.session-memory.recovery",
			content: expect.stringContaining("Compacted task"),
			display: false,
			timestamp: 0,
		});
		expect(JSON.stringify(first.messages[1])).not.toContain("Later task");

		const laterCheckpoint = {
			...checkpoint,
			toolCallId: "later-checkpoint",
			checkpoint: 2,
			state: { ...state, tasks: ["Later checkpoint task"] },
		};
		const afterCheckpoint = projectSessionMemory(
			[compaction, later],
			replaySessionMemory([
				...branch,
				entry("later-checkpoint-result", result("later-checkpoint", laterCheckpoint)),
			]),
		);
		expect(afterCheckpoint.messages[1]).toMatchObject({
			role: "custom",
			content: expect.stringContaining("Later checkpoint task"),
		});
	});

	it("appends one stable task reminder after ten successful tool results until the next update", () => {
		const toolResults = Array.from({ length: TASK_REMINDER_TOOL_RESULTS }, (_, index) => {
			const message: ToolResultMessage = {
				role: "toolResult",
				toolCallId: `read-${index}`,
				toolName: "read",
				content: [{ type: "text", text: "done" }],
				isError: false,
				timestamp: 1,
			};
			return entry(`read-${index}`, message);
		});
		const messages = toolResults.map((item) => {
			if (item.type !== "message") throw new Error("expected message entry");
			return item.message;
		});
		const beforeThreshold = projectSessionMemory(
			messages.slice(0, -1),
			replaySessionMemory(toolResults.slice(0, -1)),
		);
		expect(beforeThreshold.messages.some((message) => message.role === "custom")).toBe(false);

		const replay = replaySessionMemory(toolResults);
		const first = projectSessionMemory(messages, replay);
		const second = projectSessionMemory(messages, replay);
		expect(first).toEqual(second);
		expect(first.messages.at(-1)).toMatchObject({
			role: "custom",
			customType: "tau.session-memory.task-reminder",
			display: false,
			timestamp: 0,
			content: expect.stringContaining("only unfinished work"),
		});
		expect(projectSessionMemory(first.messages, replay)).toEqual(first);

		const update = {
			...details("update"),
			kind: "update" as const,
		};
		const updateCall = fauxAssistantMessage(fauxToolCall("session_memory", { action: "update" }, { id: "update" }));
		const afterUpdate = projectSessionMemory(
			[...messages, updateCall, result("update", update)],
			replaySessionMemory([
				...toolResults,
				entry("update-call", updateCall),
				entry("update-result", result("update", update)),
			]),
		);
		expect(
			afterUpdate.messages.some(
				(message) => message.role === "custom" && message.customType === "tau.session-memory.task-reminder",
			),
		).toBe(false);
	});

	it("collects tool and injected-file rows before a checkpoint", () => {
		const outline: SessionEntry = {
			type: "custom_message",
			id: "outline",
			parentId: null,
			timestamp: "2026-07-29",
			customType: "tau.explore.outline",
			content: "outline",
			display: true,
			details: { rowId: "outline-row" },
		};
		const branch = [
			entry("call", fauxAssistantMessage(fauxToolCall("read", { path: "a.ts" }, { id: "read-row" }))),
			outline,
		];
		expect(collectPrunedRowIds(branch, branch.length)).toEqual(["read-row", "outline-row"]);
	});
});
