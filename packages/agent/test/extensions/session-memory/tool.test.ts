import { fauxAssistantMessage, fauxToolCall, type ToolResultMessage } from "@earendil-works/pi-ai";
import {
	createEventBus,
	type ExtensionAPI,
	type ExtensionContext,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { registerOutlineInjectionProvider, type PreparedOutlineInjection } from "../../../shared/outline-injection.ts";
import {
	formatSessionMemory,
	type SessionMemoryDetailsV2,
	type SessionMemoryInput,
} from "../../../extensions/session-memory/state.ts";
import { executeSessionMemory } from "../../../extensions/session-memory/tool.ts";

const update: Extract<SessionMemoryInput, { action: "update" }> = {
	action: "update",
	longTermGoal: "Ship session memory",
	tasks: ["Run transaction"],
	shortTermMemories: [{ id: "new-finding", text: "Keep for one span." }],
	longTermMemories: [],
	readFiles: ["active.ts"],
	outlineFiles: [],
	deferFiles: [],
};

function pi(): ExtensionAPI {
	const events = createEventBus();
	return {
		events,
		on(name: string, handler: () => void) {
			if (name === "session_start") handler();
		},
	} as unknown as ExtensionAPI;
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

function call(id: string, input: SessionMemoryInput): SessionEntry {
	return {
		type: "message",
		id: `${id}-call`,
		parentId: null,
		timestamp: "2026-07-29T12:00:00.000Z",
		message: fauxAssistantMessage(fauxToolCall("session_memory", input, { id })),
	};
}

function outline(path: string): PreparedOutlineInjection {
	return {
		customType: "tau.explore.outline",
		content: `${path}\noutline`,
		display: true,
		details: { v: 1, rowId: `outline:${path}`, path, cwd: "/work", batchId: "current:outline" },
	};
}

function options(input: SessionMemoryInput, branch: SessionEntry[] = [call("current", input)]) {
	const extension = pi();
	return {
		pi: extension,
		toolCallId: "current",
		params: input,
		signal: undefined,
		ctx: {
			cwd: "/work",
			hasUI: false,
			sessionManager: { getBranch: () => branch },
			ui: { confirm: vi.fn() },
		} as unknown as ExtensionContext,
		generation: 1,
		currentGeneration: () => 1,
		required: false,
	};
}

describe("session-memory tool", () => {
	it("commits a full authoritative update without loading its file manifest", async () => {
		const input = { ...update, outlineFiles: ["related.ts"] };
		const test = options(input);
		const outlineProvider = vi.fn(async () => ({ messages: [], warnings: [] }));
		registerOutlineInjectionProvider(test.pi, outlineProvider);
		const execution = await executeSessionMemory(test);
		expect(execution.result.details).toMatchObject({
			kind: "update",
			checkpoint: 0,
			state: { longTermGoal: input.longTermGoal, outlineFiles: ["related.ts"] },
		});
		expect(execution.result.content[0]?.text).toContain("Session memory · checkpoint 0");
		expect(execution.result.content[0]?.text).toContain("new-finding: Keep for one span.");
		expect(execution.result.details.changes).toEqual(["Session memory created"]);
		expect(execution.readFiles).toEqual([]);
		expect(execution.outlines).toEqual([]);
		expect(outlineProvider).not.toHaveBeenCalled();
	});

	it("records a compact summary of changes from the previous update", async () => {
		const first = await executeSessionMemory(options(update));
		const changed = {
			...update,
			tasks: ["Write docs", "Run checks"],
			shortTermMemories: [{ id: "new-memory", text: "A new finding." }],
			longTermMemories: [{ id: "new-finding", text: "Keep for one span." }],
			readFiles: [],
			outlineFiles: ["active.ts"],
		};
		const branch = [
			call("prior", update),
			{
				type: "message",
				id: "prior-result",
				parentId: null,
				timestamp: "2026-07-29T12:00:01.000Z",
				message: result("prior", { ...first.result.details, toolCallId: "prior" }),
			} satisfies SessionEntry,
			call("current", changed),
		];
		const execution = await executeSessionMemory(options(changed, branch));
		expect(execution.result.details.changes).toEqual([
			"2 new tasks",
			"1 task closed",
			"1 new memory",
			"1 memory promoted",
			"1 file tier changed",
		]);
	});

	it("rejects voluntary checkpoints without an update in the current span", async () => {
		await expect(executeSessionMemory(options({ action: "checkpoint" }))).rejects.toThrow(
			"requires a successful update",
		);
	});

	it("rejects a voluntary checkpoint bundled with sibling tool calls", async () => {
		const first = await executeSessionMemory(options(update));
		const branch: SessionEntry[] = [
			call("update", update),
			{
				type: "message",
				id: "update-result",
				parentId: null,
				timestamp: "2026-07-29T12:00:01.000Z",
				message: result("update", { ...first.result.details, toolCallId: "update" }),
			} satisfies SessionEntry,
			{
				type: "message",
				id: "current-call",
				parentId: null,
				timestamp: "2026-07-29T12:00:02.000Z",
				message: fauxAssistantMessage([
					fauxToolCall("session_memory", { action: "checkpoint" }, { id: "current" }),
					fauxToolCall("read", { path: "after.ts" }, { id: "sibling" }),
				]),
			},
		];
		await expect(executeSessionMemory(options({ action: "checkpoint" }, branch))).rejects.toThrow(
			"must be the only tool call",
		);
	});

	it("checkpoints the latest update and reinjects the full file working set", async () => {
		const input = { ...update, outlineFiles: ["related.ts"] };
		const first = await executeSessionMemory(options(input));
		const firstDetails = first.result.details;
		const branch = [
			call("update", input),
			{
				type: "message",
				id: "update-result",
				parentId: null,
				timestamp: "2026-07-29T12:00:01.000Z",
				message: result("update", { ...firstDetails, toolCallId: "update" }),
			} satisfies SessionEntry,
			call("current", { action: "checkpoint" }),
		];
		const test = options({ action: "checkpoint" }, branch);
		const outlineProvider = vi.fn(async () => ({ messages: [outline("related.ts")], warnings: [] }));
		registerOutlineInjectionProvider(test.pi, outlineProvider);
		const execution = await executeSessionMemory(test);
		expect(execution.result.details.kind).toBe("checkpoint");
		expect(execution.result.details.checkpoint).toBe(1);
		expect(execution.result.details.changes).toEqual(["Checkpoint 1 created"]);
		expect(execution.result.details.state.shortTermMemories[0]?.bornAtCheckpoint).toBe(0);
		expect(execution.readFiles).toEqual(["active.ts"]);
		expect(execution.outlines).toEqual([outline("related.ts")]);
		expect(execution.result.details.outlinedRows).toEqual([{ path: "related.ts", rowId: "outline:related.ts" }]);
		expect(outlineProvider).toHaveBeenCalledOnce();
	});

	it("turns the required full update into a checkpoint and ages new short-term memory from it", async () => {
		const execution = await executeSessionMemory({ ...options(update), required: true });
		expect(execution.result.details.kind).toBe("checkpoint");
		expect(execution.result.details.checkpoint).toBe(1);
		expect(execution.result.details.changes).toEqual(["Checkpoint 1 created", "Session memory created"]);
		expect(execution.result.details.state.shortTermMemories[0]?.bornAtCheckpoint).toBe(1);
		expect(execution.readFiles).toEqual(["active.ts"]);
	});

	it.each([
		[null, "New long-term goal"],
		["Ship session memory", null],
		["Ship session memory", "Different long-term goal"],
	])("accepts an agent-managed long-term goal change from %s to %s", async (previousGoal, nextGoal) => {
		const previous = { ...update, longTermGoal: previousGoal };
		const initial = await executeSessionMemory(options(previous));
		const changed = { ...update, longTermGoal: nextGoal };
		const branch = [
			call("prior", previous),
			{
				type: "message",
				id: "prior-result",
				parentId: null,
				timestamp: "2026-07-29T12:00:01.000Z",
				message: result("prior", { ...initial.result.details, toolCallId: "prior" }),
			} satisfies SessionEntry,
			call("current", changed),
		];
		const execution = await executeSessionMemory(options(changed, branch));
		expect(execution.result.details.state.longTermGoal).toBe(nextGoal);
		expect(execution.result.details.changes).toContain("Long-term goal updated");
	});

	it("keeps a requested outline in the manifest when checkpoint loading fails", async () => {
		const input = {
			...update,
			outlineFiles: ["related.ts"],
		};
		const first = await executeSessionMemory(options(input));
		const branch = [
			call("update", input),
			{
				type: "message",
				id: "update-result",
				parentId: null,
				timestamp: "2026-07-29T12:00:01.000Z",
				message: result("update", { ...first.result.details, toolCallId: "update" }),
			} satisfies SessionEntry,
			call("current", { action: "checkpoint" }),
		];
		const test = options({ action: "checkpoint" }, branch);
		registerOutlineInjectionProvider(test.pi, async () => ({
			messages: [],
			warnings: ["related.ts: outline unavailable"],
		}));
		const execution = await executeSessionMemory(test);
		expect(execution.result.details.state.outlineFiles).toEqual(["related.ts"]);
		expect(execution.result.details.state.deferFiles).toEqual([]);
		expect(execution.result.details.outlinedRows).toEqual([]);
		expect(execution.result.details.warnings).toEqual(["related.ts: outline unavailable"]);
	});
});
