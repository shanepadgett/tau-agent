import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { renderedText, testRowState, testTheme } from "../../helpers.ts";
import { renderSessionMemoryCall, renderSessionMemoryResult } from "../../../extensions/session-memory/render.ts";
import {
	formatSessionMemory,
	type SessionMemoryDetailsV1,
	type SessionMemoryInput,
} from "../../../extensions/session-memory/state.ts";

const args: SessionMemoryInput = {
	action: "update",
	goal: "Ship session memory",
	objective: "Test rendering",
	tasks: ["Render compact rows"],
	carry: [{ id: "finding", text: "Useful finding." }],
	durable: [{ id: "rule", text: "Stable rule." }],
	readFiles: ["active.ts"],
	outlineFiles: ["related.ts"],
	deferFiles: [{ path: "later.ts", reason: "inactive", relevantWhen: "tests fail" }],
};

const details: SessionMemoryDetailsV1 = {
	v: 1,
	toolCallId: "memory-call",
	kind: "update",
	checkpoint: 2,
	state: {
		goal: args.action === "update" ? args.goal : "",
		objective: args.action === "update" ? args.objective : "",
		tasks: args.action === "update" ? args.tasks : [],
		carry: [{ id: "finding", text: "Useful finding.", bornAtCheckpoint: 2 }],
		durable: [{ id: "rule", text: "Stable rule." }],
		readFiles: ["active.ts"],
		outlineFiles: ["related.ts"],
		deferFiles: [{ path: "later.ts", reason: "inactive", relevantWhen: "tests fail" }],
	},
	outlinedRows: [{ path: "related.ts", rowId: "outline-row" }],
	prunedRowIds: [],
	warnings: [],
};

const text = formatSessionMemory(details.state, details.checkpoint, details.warnings);
const result = { content: [{ type: "text" as const, text }], details } as AgentToolResult<unknown>;

describe("session-memory rendering", () => {
	it("shows update counts before execution and one compact authoritative result", () => {
		const call = renderSessionMemoryCall(args, testTheme, {
			rowState: testRowState,
			rowId: "memory-call",
			invalidate() {},
			lastComponent: undefined,
			executionStarted: false,
		});
		expect(renderedText(call)).toContain("1 tasks · 1 carry · 1 durable · 1 read · 1 outline · 1 deferred");

		const settledCall = renderSessionMemoryCall(args, testTheme, {
			rowState: testRowState,
			rowId: "memory-call",
			invalidate() {},
			lastComponent: call,
			executionStarted: true,
		});
		expect(renderedText(settledCall)).toBe("");

		const collapsed = renderSessionMemoryResult(result, false, testTheme, undefined, "memory-call");
		expect(renderedText(collapsed)).toContain("Updated · 1 tasks · 1 carry · 1 durable · 3 files");
		const expanded = renderSessionMemoryResult(result, true, testTheme, undefined, "memory-call");
		expect(renderedText(expanded)).toContain("Session memory · checkpoint 2");
		expect(renderedText(expanded)).toContain("finding: Useful finding.");
	});
});
