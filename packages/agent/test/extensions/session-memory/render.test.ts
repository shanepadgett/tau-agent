import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { renderedText, testRowState, testTheme } from "../../helpers.ts";
import { renderSessionMemoryCall, renderSessionMemoryResult } from "../../../extensions/session-memory/render.ts";
import {
	formatSessionMemory,
	type SessionMemoryDetailsV2,
	type SessionMemoryInput,
} from "../../../extensions/session-memory/state.ts";

const args: SessionMemoryInput = {
	action: "update",
	longTermGoal: "Ship session memory",
	tasks: ["Render compact rows"],
	shortTermMemories: [{ id: "finding", text: "Useful finding." }],
	longTermMemories: [{ id: "rule", text: "Stable rule." }],
	readFiles: ["active.ts"],
	outlineFiles: ["related.ts"],
	deferFiles: [{ path: "later.ts", reason: "inactive", relevantWhen: "tests fail" }],
};

const details: SessionMemoryDetailsV2 = {
	v: 2,
	toolCallId: "memory-call",
	kind: "update",
	checkpoint: 2,
	state: {
		longTermGoal: args.action === "update" ? args.longTermGoal : null,
		tasks: args.action === "update" ? args.tasks : [],
		shortTermMemories: [{ id: "finding", text: "Useful finding.", bornAtCheckpoint: 2 }],
		longTermMemories: [{ id: "rule", text: "Stable rule." }],
		readFiles: ["active.ts"],
		outlineFiles: ["related.ts"],
		deferFiles: [{ path: "later.ts", reason: "inactive", relevantWhen: "tests fail" }],
	},
	changes: ["Long-term goal updated", "2 new tasks", "1 task closed", "1 memory promoted"],
	outlinedRows: [{ path: "related.ts", rowId: "outline-row" }],
	prunedRowIds: [],
	warnings: [],
};

const text = formatSessionMemory(details.state, details.checkpoint, details.warnings);
const result = { content: [{ type: "text" as const, text }], details } as AgentToolResult<unknown>;

describe("session-memory rendering", () => {
	it("shows only the tool name in the call and the full current state in the result", () => {
		const call = renderSessionMemoryCall(args, testTheme, {
			visible: true,
			rowState: testRowState,
			rowId: "memory-call",
			invalidate() {},
			lastComponent: undefined,
		});
		expect(renderedText(call)).toBe("<toolTitle>*session_memory*</toolTitle>");

		const settledCall = renderSessionMemoryCall(args, testTheme, {
			visible: true,
			rowState: testRowState,
			rowId: "memory-call",
			invalidate() {},
			lastComponent: call,
		});
		expect(renderedText(settledCall)).toBe("<toolTitle>*session_memory*</toolTitle>");

		const renderedResult = renderedText(renderSessionMemoryResult(result, true, testTheme, undefined));
		expect(renderedResult).toContain("Session memory · checkpoint 2");
		expect(renderedResult).toContain("Long-term goal");
		expect(renderedResult).toContain("Ship session memory");
		expect(renderedResult).toContain("finding: Useful finding.");
	});

	it("shows error result text without special handling", () => {
		const validationText = [
			'Validation failed for tool "session_memory":',
			"  - readFiles: must not have more than 12 items",
			"  - root: must match a schema in anyOf",
			"",
			"Received arguments:",
			'{ "action": "update", "readFiles": ["…"] }',
		].join("\n");
		const error = {
			content: [{ type: "text" as const, text: validationText }],
		} as AgentToolResult<unknown>;
		const renderedResult = renderedText(renderSessionMemoryResult(error, true, testTheme, undefined));
		for (const line of validationText.split("\n").filter(Boolean)) expect(renderedResult).toContain(line);
	});

	it("renders no call or result content when tool rows are hidden", () => {
		const call = renderSessionMemoryCall(args, testTheme, {
			visible: false,
			rowState: testRowState,
			rowId: "memory-call",
			invalidate() {},
			lastComponent: undefined,
		});
		expect(renderedText(call)).toBe("");

		const visibleResult = renderSessionMemoryResult(result, true, testTheme, undefined);
		const hiddenResult = renderSessionMemoryResult(result, false, testTheme, visibleResult);
		expect(renderedText(hiddenResult)).toBe("");
	});
});
