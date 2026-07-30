import { fauxAssistantMessage, fauxToolCall, type ToolResultMessage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
	assertSnapshotBound,
	checkpointState,
	formatSessionMemory,
	MAX_SNAPSHOT_BYTES,
	normalizeUpdate,
	parseSessionMemoryDetails,
	replaySessionMemory,
	sessionMemoryParameters,
	type SessionMemoryDetailsV2,
	type SessionMemoryState,
	type SessionMemoryUpdateInput,
} from "../../../extensions/session-memory/state.ts";

const update: SessionMemoryUpdateInput = {
	action: "update",
	longTermGoal: "Ship session memory",
	tasks: ["Write tests"],
	shortTermMemories: [{ id: "new-finding", text: "Keep this for one span." }],
	longTermMemories: [{ id: "cache-stability", text: "Preserve stable request prefixes." }],
	readFiles: ["active.ts"],
	outlineFiles: ["related.ts"],
	deferFiles: [{ path: "later.ts", reason: "inactive", relevantWhen: "tests fail" }],
};

function details(
	toolCallId: string,
	kind: "update" | "checkpoint",
	checkpoint: number,
	state: SessionMemoryState,
): SessionMemoryDetailsV2 {
	return {
		v: 2,
		toolCallId,
		kind,
		checkpoint,
		state,
		changes: ["Fixture created"],
		outlinedRows: [],
		prunedRowIds: [],
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

function toolResult(id: string, toolName = "read", isError = false): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName,
		content: [{ type: "text", text: isError ? "failed" : "done" }],
		isError,
		timestamp: 1,
	};
}

function entry(id: string, message: ToolResultMessage): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-07-29T12:00:00.000Z",
		message,
	};
}

describe("session-memory state", () => {
	it("enforces the full update or checkpoint input union", () => {
		expect(Value.Check(sessionMemoryParameters, update)).toBe(true);
		expect(Value.Check(sessionMemoryParameters, { ...update, longTermGoal: null })).toBe(true);
		expect(Value.Check(sessionMemoryParameters, { ...update, longTermGoal: "x".repeat(15_000) })).toBe(true);
		expect(Value.Check(sessionMemoryParameters, { action: "checkpoint" })).toBe(true);
		expect(Value.Check(sessionMemoryParameters, { ...update, longTermGoal: undefined })).toBe(false);
		expect(Value.Check(sessionMemoryParameters, { action: "checkpoint", longTermGoal: "extra" })).toBe(false);
		expect(
			Value.Check(sessionMemoryParameters, { ...update, shortTermMemories: [{ id: "Not-Kebab", text: "bad" }] }),
		).toBe(false);
	});

	it("normalizes full replacement state and file-tier precedence", () => {
		const state = normalizeUpdate(
			{
				...update,
				longTermGoal: "  Ship session memory  ",
				readFiles: ["@active.ts", "./active.ts"],
				outlineFiles: ["active.ts", "related.ts", "related.ts"],
				deferFiles: [
					{ path: "related.ts", reason: " lower tier ", relevantWhen: " later " },
					{ path: "later.ts", reason: " inactive ", relevantWhen: " tests fail " },
				],
			},
			undefined,
			0,
			"/work",
		);
		expect(state.longTermGoal).toBe("Ship session memory");
		expect(state.readFiles).toEqual(["active.ts"]);
		expect(state.outlineFiles).toEqual(["related.ts"]);
		expect(state.deferFiles).toEqual([{ path: "later.ts", reason: "inactive", relevantWhen: "tests fail" }]);
	});

	it("keeps short-term memory for one checkpoint span without resetting age on edit", () => {
		const initial = normalizeUpdate(update, undefined, 0, "/work");
		const first = checkpointState(initial, 0);
		expect(first.state.shortTermMemories[0]?.bornAtCheckpoint).toBe(0);
		expect(first.warnings).toEqual([]);

		const edited = normalizeUpdate(
			{ ...update, shortTermMemories: [{ id: "new-finding", text: "Edited without extending lifetime." }] },
			first.state,
			1,
			"/work",
		);
		expect(edited.shortTermMemories[0]?.bornAtCheckpoint).toBe(0);
		const second = checkpointState(edited, 1);
		expect(second.state.shortTermMemories).toEqual([]);
		expect(second.warnings).toEqual(["new-finding: short-term memory expired"]);
	});

	it("promotes short-term memory by keeping the same ID in long-term memory", () => {
		const initial = normalizeUpdate(update, undefined, 0, "/work");
		const promoted = normalizeUpdate(
			{
				...update,
				shortTermMemories: [],
				longTermMemories: [
					...update.longTermMemories,
					{ id: "new-finding", text: "Keep this until explicitly forgotten." },
				],
			},
			initial,
			1,
			"/work",
		);
		const checkpoint = checkpointState(promoted, 1);
		expect(checkpoint.state.shortTermMemories).toEqual([]);
		expect(checkpoint.state.longTermMemories.map((item) => item.id)).toContain("new-finding");
	});

	it("strictly parses canonical details and replays the latest valid branch state", () => {
		const state = normalizeUpdate(update, undefined, 0, "/work");
		const first = details("update-1", "update", 0, state);
		const checkpoint = details("checkpoint-1", "checkpoint", 1, checkpointState(state, 0).state);
		const firstText = formatSessionMemory(first.state, first.checkpoint, first.warnings);
		expect(parseSessionMemoryDetails(first, "update-1", firstText, "/work")).toEqual(first);
		expect(parseSessionMemoryDetails({ ...first, extra: true }, "update-1", firstText, "/work")).toBeUndefined();
		expect(parseSessionMemoryDetails(first, "wrong", firstText, "/work")).toBeUndefined();
		expect(parseSessionMemoryDetails(first, "update-1", `${firstText}\nchanged`, "/work")).toBeUndefined();

		const branch = [
			{
				type: "message",
				id: "update-call",
				parentId: null,
				timestamp: "2026-07-29T12:00:00.000Z",
				message: fauxAssistantMessage(fauxToolCall("session_memory", update, { id: "update-1" })),
			},
			{
				type: "message",
				id: "update-result",
				parentId: "update-call",
				timestamp: "2026-07-29T12:00:01.000Z",
				message: result("update-1", first),
			},
			{
				type: "message",
				id: "checkpoint-call",
				parentId: "update-result",
				timestamp: "2026-07-29T12:00:02.000Z",
				message: fauxAssistantMessage(
					fauxToolCall("session_memory", { action: "checkpoint" }, { id: "checkpoint-1" }),
				),
			},
			{
				type: "message",
				id: "checkpoint-result",
				parentId: "checkpoint-call",
				timestamp: "2026-07-29T12:00:03.000Z",
				message: result("checkpoint-1", checkpoint),
			},
		] satisfies SessionEntry[];
		const replay = replaySessionMemory(branch, "/work");
		expect(replay.latest).toEqual(checkpoint);
		expect(replay.latestCheckpoint).toEqual(checkpoint);
		expect(replay.updateSinceCheckpoint).toBe(false);
		expect(replay.updatedAt).toBe(Date.parse("2026-07-29T12:00:03.000Z"));
	});

	it("counts successful non-memory tool results since the latest valid update", () => {
		const state = normalizeUpdate(update, undefined, 0, "/work");
		const ordinaryUpdate = details("update-1", "update", 0, state);
		const requiredUpdate = details("required-update", "checkpoint", 1, state);
		const branch: SessionEntry[] = [
			entry("before-update", toolResult("before-update")),
			{
				type: "message",
				id: "update-call",
				parentId: null,
				timestamp: "2026-07-29T12:00:01.000Z",
				message: fauxAssistantMessage(fauxToolCall("session_memory", update, { id: "update-1" })),
			},
			entry("update-result", result("update-1", ordinaryUpdate)),
			...Array.from({ length: 6 }, (_, index) => entry(`success-${index}`, toolResult(`success-${index}`))),
			entry("failed", toolResult("failed", "bash", true)),
			entry("malformed-memory", toolResult("malformed-memory", "session_memory")),
			...Array.from({ length: 4 }, (_, index) => entry(`more-${index}`, toolResult(`more-${index}`, "bash"))),
		];

		expect(replaySessionMemory(branch, "/work").successfulToolResultsSinceUpdate).toBe(10);

		branch.push(
			{
				type: "message",
				id: "required-update-call",
				parentId: null,
				timestamp: "2026-07-29T12:00:02.000Z",
				message: fauxAssistantMessage(fauxToolCall("session_memory", update, { id: "required-update" })),
			},
			entry("required-update-result", result("required-update", requiredUpdate)),
		);
		expect(replaySessionMemory(branch, "/work").successfulToolResultsSinceUpdate).toBe(0);
	});

	it("rejects a canonical snapshot over 16,000 UTF-8 bytes", () => {
		const state = normalizeUpdate(
			{
				...update,
				shortTermMemories: Array.from({ length: 12 }, (_, index) => ({
					id: `short-term-${index}`,
					text: "x".repeat(1_000),
				})),
				longTermMemories: Array.from({ length: 24 }, (_, index) => ({
					id: `long-term-${index}`,
					text: "y".repeat(1_000),
				})),
			},
			undefined,
			0,
			"/work",
		);
		expect(() => assertSnapshotBound(state, 0)).toThrow("16,000 UTF-8 bytes");
	});

	it("keeps warning output within the snapshot byte bound", () => {
		const base: SessionMemoryState = {
			longTermGoal: "Ship session memory",
			tasks: [],
			shortTermMemories: Array.from({ length: 12 }, (_, index) => ({
				id: `short-term-${index}`,
				text: "x".repeat(1_000),
				bornAtCheckpoint: 0,
			})),
			longTermMemories: [
				...Array.from({ length: 3 }, (_, index) => ({
					id: `long-term-${index}`,
					text: "y".repeat(1_000),
				})),
				{ id: "padding", text: "z" },
			],
			readFiles: [],
			outlineFiles: [],
			deferFiles: [],
		};
		const initialBytes = Buffer.byteLength(formatSessionMemory(base, 0, []), "utf8");
		const padding = MAX_SNAPSHOT_BYTES - initialBytes - 1;
		expect(padding).toBeGreaterThan(0);
		expect(padding).toBeLessThan(1_000);
		base.longTermMemories[3] = { id: "padding", text: "z".repeat(padding + 1) };

		const output = formatSessionMemory(base, 0, ["warning"]);
		expect(Buffer.byteLength(output, "utf8")).toBeLessThanOrEqual(MAX_SNAPSHOT_BYTES);
	});
});
