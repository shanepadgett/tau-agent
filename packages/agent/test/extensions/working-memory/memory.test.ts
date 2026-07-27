import { fauxAssistantMessage, fauxText, fauxToolCall, type ToolResultMessage } from "@earendil-works/pi-ai";
import type { ContextEvent, SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { buildMemoryCatalog, projectWorkingMemory } from "../../../extensions/working-memory/memory.ts";
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
	it("selects assistant prose and individual complete tool exchanges", () => {
		const assistant = fauxAssistantMessage([
			fauxText("useful conclusion"),
			fauxToolCall("read", { path: "a.ts" }, { id: "read-a" }),
			fauxToolCall("grep", { pattern: "x" }, { id: "grep-x" }),
		]);
		const branch = [
			entry("assistant", assistant),
			entry("read-result", result("read-a", "read")),
			entry("grep-result", result("grep-x", "grep")),
		];
		const catalog = buildMemoryCatalog(branch);
		expect([...catalog.keys()]).toEqual(["m:assistant", "t:assistant:1", "t:assistant:2"]);
		expect(catalog.get("t:assistant:1")?.messages).toHaveLength(2);
	});

	it("hard-checkpoints context, sanitizes continuation arguments, and annotates retained refs", () => {
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
		expect(projected).toHaveLength(3);
		expect(projected[0]).toMatchObject({ role: "user", content: expect.stringContaining("[wm m:user]") });
		const projectedAnchor = projected[1];
		if (projectedAnchor?.role !== "assistant") throw new Error("expected assistant anchor");
		const call = projectedAnchor.content.find((block) => block.type === "toolCall");
		expect(call?.type === "toolCall" ? call.arguments : undefined).toEqual({ checkpoint: true });
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
