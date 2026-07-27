import { fauxAssistantMessage, fauxToolCall, type ToolResultMessage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
	parseWorkingMemoryDetails,
	replayWorkingMemoryState,
	type WorkingMemoryCheckpointDetailsV1,
} from "../../../extensions/working-memory/state.ts";

function details(anchorToolCallId: string): WorkingMemoryCheckpointDetailsV1 {
	return {
		v: 1,
		anchorToolCallId,
		retainedRefs: ["m:user"],
		retainedLabels: [{ ref: "m:user", label: "user", preview: "constraint" }],
		prunedRowIds: ["old-tool"],
		outlinedFiles: [],
		deferredFiles: [],
		removedUnits: 4,
		warnings: [],
	};
}

function result(id: string, value: unknown): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: "working_memory",
		content: [{ type: "text", text: "continued" }],
		isError: false,
		timestamp: 1,
		details: value,
	};
}

describe("working-memory state", () => {
	it("strictly parses and replays latest valid checkpoint", () => {
		const valid = details("anchor");
		expect(parseWorkingMemoryDetails(valid)).toEqual(valid);
		expect(parseWorkingMemoryDetails({ ...valid, retainedRefs: ["m:user", "m:user"] })).toBeUndefined();
		const branch = [
			{
				type: "message",
				id: "call",
				parentId: null,
				timestamp: "2026-01-01",
				message: fauxAssistantMessage(fauxToolCall("working_memory", {}, { id: "anchor" })),
			},
			{
				type: "message",
				id: "result",
				parentId: "call",
				timestamp: "2026-01-01",
				message: result("anchor", valid),
			},
		] satisfies SessionEntry[];
		const state = replayWorkingMemoryState(branch, true);
		expect(state.latestAnchorToolCallId).toBe("anchor");
		expect(state.retainedRefs).toEqual(["m:user"]);
		expect([...state.prunedRowIds]).toEqual(["old-tool"]);
	});
});
