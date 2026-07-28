import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { renderedText, testRowState, testTheme } from "../../helpers.ts";
import type { WorkingMemoryInput } from "../../../extensions/working-memory/checkpoint.ts";
import { renderWorkingMemoryCall, renderWorkingMemoryResult } from "../../../extensions/working-memory/render.ts";
import type { WorkingMemoryCheckpointDetailsV2 } from "../../../extensions/working-memory/state.ts";

const args: WorkingMemoryInput = {
	continuation: "Continue implementation.",
	keep: ["m:user"],
	readFiles: ["active.ts"],
	outlineFiles: ["related.ts"],
	deferFiles: [{ path: "later.ts", reason: "inactive", relevantWhen: "tests fail" }],
};

const details: WorkingMemoryCheckpointDetailsV2 = {
	v: 2,
	anchorToolCallId: "checkpoint",
	retainedRefs: ["m:user"],
	retainedLabels: [{ ref: "m:user", label: "user", preview: "constraint" }],
	prunedRowIds: ["read-old"],
	readFiles: ["active.ts"],
	outlinedFiles: [{ path: "related.ts", rowId: "checkpoint:0" }],
	deferredFiles: args.deferFiles,
	removedUnits: 1,
	warnings: [],
};

const result = {
	content: [{ type: "text" as const, text: "## Continue\n\nContinue implementation." }],
	details,
} as AgentToolResult<unknown>;

describe("working-memory rendering", () => {
	it("replaces the call summary with one completed row and expands its context", () => {
		const call = renderWorkingMemoryCall(args, testTheme, {
			rowState: testRowState,
			rowId: "checkpoint",
			invalidate() {},
			lastComponent: undefined,
			executionStarted: true,
		});
		expect(renderedText(call)).toBe("");

		const collapsed = renderWorkingMemoryResult(result, false, testTheme, undefined);
		expect(renderedText(collapsed)).toContain("Checkpoint · kept 1 · read 1 · outlined 1 · deferred 1 · pruned 1");

		const expanded = renderWorkingMemoryResult(result, true, testTheme, undefined);
		expect(renderedText(expanded)).toContain("## Continue");
		expect(renderedText(expanded)).toContain("read: active.ts");
		expect(renderedText(expanded)).toContain("outlined: related.ts");
	});
});
