import {
	fauxAssistantMessage,
	fauxText,
	fauxThinking,
	fauxToolCall,
	type ToolResultMessage,
} from "@earendil-works/pi-ai";
import type { ContextEvent, SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
	buildMemoryCatalog,
	collectPrunedRowIds,
	projectWorkingMemory,
} from "../../../extensions/working-memory/memory.ts";
import type { ActiveWorkingMemoryState } from "../../../extensions/working-memory/state.ts";

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

function entry(id: string, message: ContextEvent["messages"][number]): SessionEntry {
	return { type: "message", id, parentId: null, timestamp: "2026-01-01", message };
}

describe("working-memory catalog and projection", () => {
	it("selects only user messages and visible assistant text", () => {
		const assistant = fauxAssistantMessage([
			fauxThinking("private reasoning"),
			fauxText("useful conclusion"),
			fauxToolCall("read", { path: "a.ts" }, { id: "read-a" }),
			fauxToolCall("grep", { pattern: "x" }, { id: "grep-x" }),
		]);
		const thinking = fauxAssistantMessage(fauxThinking("thinking only"));
		const branch = [
			entry("user", { role: "user", content: "important instruction", timestamp: 1 }),
			entry("assistant", assistant),
			entry("read-result", result("read-a", "read")),
			entry("grep-result", result("grep-x", "grep")),
			entry("thinking", thinking),
		];
		const catalog = buildMemoryCatalog(branch);
		expect([...catalog.keys()]).toEqual(["m:user", "m:assistant"]);
		expect(JSON.stringify(catalog.get("m:assistant")?.messages)).toContain("useful conclusion");
		expect(JSON.stringify(catalog.get("m:assistant")?.messages)).not.toContain("private reasoning");
		expect(JSON.stringify(catalog.get("m:assistant")?.messages)).not.toContain("read-a");
	});

	it("tracks pruned tool and outline rows without making them selectable", () => {
		const call = entry("call", fauxAssistantMessage(fauxToolCall("read", { path: "a.ts" }, { id: "read-a" })));
		const outline: SessionEntry = {
			type: "custom_message",
			id: "outline",
			parentId: call.id,
			timestamp: "2026-01-01",
			customType: "tau.explore.outline",
			content: "a.ts\nL1: export const a = 1",
			display: true,
			details: { rowId: "outline-row" },
		};
		const branch = [call, entry("result", result("read-a", "read")), outline];
		expect(buildMemoryCatalog(branch).size).toBe(0);
		expect(collectPrunedRowIds(branch, branch.length)).toEqual(["read-a", "outline-row"]);
	});

	it("hard-checkpoints context, sanitizes continuation arguments, and hides retained refs", () => {
		const oldUser = { role: "user" as const, content: "original constraint", timestamp: 1 };
		const oldCall = fauxAssistantMessage(fauxToolCall("read", { path: "a.ts" }, { id: "read-a" }));
		const anchor = fauxAssistantMessage(
			fauxToolCall(
				"working_memory",
				{ continuation: "duplicate", keep: ["m:user"], outlineFiles: [], deferFiles: [] },
				{ id: "anchor" },
			),
		);
		const branch = [
			entry("user", oldUser),
			entry("call", oldCall),
			entry("call-result", result("read-a", "read")),
			entry("anchor-entry", anchor),
			entry("anchor-result", result("anchor", "working_memory")),
		];
		const messages = branch.flatMap((item) => (item.type === "message" ? [item.message] : []));
		const state: ActiveWorkingMemoryState = {
			latestAnchorToolCallId: "anchor",
			retainedRefs: ["m:user"],
			prunedRowIds: new Set(),
		};
		const projected = projectWorkingMemory(messages, state, branch, branch);
		expect(projected).toHaveLength(5);
		expect(projected[2]).toMatchObject({
			role: "custom",
			customType: "tau.working-memory.references",
			content: expect.stringContaining("m:user (user): original constraint"),
			display: false,
		});
		expect(projected[1]).toEqual(oldUser);
		expect(JSON.stringify(projected)).not.toContain("[wm ");
		const projectedAnchor = projected[3];
		if (projectedAnchor?.role !== "assistant") throw new Error("expected assistant anchor");
		const call = projectedAnchor.content.find((block) => block.type === "toolCall");
		expect(call?.type === "toolCall" ? call.arguments : undefined).toEqual({ checkpoint: true });
	});

	it("keeps projected context append-only as new messages arrive", () => {
		const userMessage = { role: "user" as const, content: "constraint", timestamp: 1 };
		const assistantMessage = fauxAssistantMessage(fauxText("conclusion"));
		const user = entry("user", userMessage);
		const assistant = entry("assistant", assistantMessage);
		const state: ActiveWorkingMemoryState = {
			latestAnchorToolCallId: undefined,
			retainedRefs: [],
			prunedRowIds: new Set(),
		};
		const first = projectWorkingMemory([userMessage], state, [user], [user]);
		const extendedBranch = [user, assistant];
		const second = projectWorkingMemory([userMessage, assistantMessage], state, extendedBranch, extendedBranch);
		expect(second.slice(0, first.length)).toEqual(first);
	});

	it("keeps memory references when Context appends an ambient projection first", () => {
		const userMessage = { role: "user" as const, content: "constraint", timestamp: 1 };
		const user = entry("user", userMessage);
		const ambient: ContextEvent["messages"][number] = {
			role: "custom",
			customType: "tau.context.projection",
			content: "current project context",
			display: false,
			timestamp: 2,
		};
		const projected = projectWorkingMemory(
			[userMessage, ambient],
			{ latestAnchorToolCallId: undefined, retainedRefs: [], prunedRowIds: new Set() },
			[user],
			[user],
		);
		expect(projected).toContainEqual(
			expect.objectContaining({
				role: "custom",
				customType: "tau.working-memory.references",
				content: expect.stringContaining("m:user"),
			}),
		);
	});

	it("keeps memory references when Context removes a legacy injection first", () => {
		const userMessage = { role: "user" as const, content: "constraint", timestamp: 1 };
		const user = entry("user", userMessage);
		const legacy: SessionEntry = {
			type: "custom_message",
			id: "legacy-context",
			parentId: user.id,
			timestamp: "2026-01-01",
			customType: "tau.injected-context",
			content: "old project context",
			display: false,
			details: { source: "context" },
		};
		const projected = projectWorkingMemory(
			[userMessage],
			{ latestAnchorToolCallId: undefined, retainedRefs: [], prunedRowIds: new Set() },
			[user, legacy],
			[user, legacy],
		);
		expect(projected).toContainEqual(
			expect.objectContaining({
				role: "custom",
				customType: "tau.working-memory.references",
				content: expect.stringContaining("m:user"),
			}),
		);
	});

	it("does not offer legacy autoread as selectable memory", () => {
		const autoread: SessionEntry = {
			type: "custom_message",
			id: "autoread",
			parentId: null,
			timestamp: "2026-01-01",
			customType: "tau.autoread",
			content: "entire file",
			display: true,
		};
		expect(buildMemoryCatalog([autoread]).size).toBe(0);
	});
});
