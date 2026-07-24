import { describe, expect, it } from "vitest";
import {
	parseContextPruningNudgeDetailsV2,
	renderContextPruneCall,
	renderContextPruneResult,
	renderContextPruningNudge,
} from "../../../extensions/context-pruning/render.ts";
import type { ContextPruneDetailsV2 } from "../../../shared/context-pruning-state.ts";
import { renderedText, testRowState, testTheme } from "../explore/helpers.ts";

function details(): ContextPruneDetailsV2 {
	return {
		v: 2,
		anchorToolCallId: "anchor",
		prunedToolCallIds: ["grep-1", "read-2"],
		prunedAutoreadRowIds: ["auto-1"],
		retainedToolCallIds: ["patch-1"],
		retainedAutoreadRowIds: [],
		refreshedFiles: [{ path: "src/current.ts", rowId: "anchor:0" }],
		deferredFiles: [{ path: "src/later.ts", reason: "cold", relevantWhen: "fallback fails" }],
		warnings: [],
	};
}

describe("context prune rendering", () => {
	it("renders informational, escalating, final-tier, and manual context markers from strict details", () => {
		const automatic = {
			v: 2 as const,
			kind: "automatic" as const,
			percent: 20,
			boundary: 20,
			reminder: 1,
			tier: 1,
			tierCount: 3,
			tierFloor: 0,
			anchorToolCallId: null,
			growthBaselinePercent: 0,
		};
		const informational = renderedText(renderContextPruningNudge(automatic, testTheme));
		expect(informational).toContain("Context:");
		expect(informational).toContain("20%");
		expect(informational).not.toContain("Prune soon.");
		const escalating = renderedText(
			renderContextPruningNudge(
				{ ...automatic, percent: 40, boundary: 40, reminder: 2, tier: 2, tierFloor: 1 },
				testTheme,
			),
		);
		expect(escalating).toContain("40%");
		expect(escalating).toContain("Prune soon.");
		const finalTier = renderedText(
			renderContextPruningNudge(
				{ ...automatic, percent: 60, boundary: 60, reminder: 3, tier: 3, tierFloor: 2 },
				testTheme,
			),
		);
		expect(finalTier).toContain("60%");
		expect(finalTier).toContain("Prune now.");
		const manual = renderedText(
			renderContextPruningNudge(
				{
					...automatic,
					kind: "manual",
					percent: null,
					boundary: null,
					reminder: null,
					tier: null,
					tierCount: null,
					tierFloor: null,
					growthBaselinePercent: null,
				},
				testTheme,
			),
		);
		expect(manual).toContain("Context:");
		expect(manual).toContain("Prune requested.");
		expect(parseContextPruningNudgeDetailsV2({ ...automatic, extra: true })).toBeUndefined();
		expect(renderContextPruningNudge({ ...automatic, percent: 101 }, testTheme)).toBeUndefined();
		expect(
			renderContextPruningNudge(
				{ ...automatic, percent: 40, boundary: 40, reminder: 2, tier: 1, tierFloor: 0 },
				testTheme,
			),
		).toBeUndefined();
		expect(
			renderContextPruningNudge({ ...automatic, percent: 100, reminder: 100, tier: 3, tierFloor: 0 }, testTheme),
		).toBeUndefined();
		expect(
			renderContextPruningNudge({ ...automatic, anchorToolCallId: null, growthBaselinePercent: 10 }, testTheme),
		).toBeUndefined();
	});

	it("renders a compact call and applied result counts", () => {
		const call = renderContextPruneCall(
			{
				keepFiles: [{ path: "src/current.ts", relevance: "active" }],
				keepToolCalls: [{ toolCallId: "patch-1", relevance: "chronology" }],
				deferFiles: [{ path: "src/later.ts", reason: "cold", relevantWhen: "fallback fails" }],
			},
			testTheme,
			{ rowState: testRowState, rowId: "anchor", invalidate() {}, lastComponent: undefined },
		);
		expect(renderedText(call)).toContain("context_prune");
		expect(renderedText(call)).toContain("3 selections");

		const result = renderContextPruneResult(
			{ content: [{ type: "text", text: "applied" }], details: details() },
			false,
			testTheme,
			undefined,
		);
		expect(renderedText(result)).toContain("Checkpoint · pruned 3 · retained 1 · refreshed 1 · deferred 1");
		expect(renderedText(result)).not.toContain("grep-1");
	});

	it("lists bounded IDs and paths only when expanded", () => {
		const many = details();
		many.prunedToolCallIds = Array.from({ length: 30 }, (_, index) => `tool-${index}`);
		const result = renderContextPruneResult(
			{ content: [{ type: "text", text: "applied" }], details: many },
			true,
			testTheme,
			undefined,
		);
		const text = renderedText(result);
		expect(text).toContain("pruned tool: tool-0");
		expect(text).toContain("more");
		expect(text).not.toContain("tool-29");
		expect(text).not.toContain("removed payload");
	});

	it("bounds each expanded value, total expanded text, and warning fallback text", () => {
		const oversized = details();
		oversized.deferredFiles = Array.from({ length: 20 }, (_, index) => ({
			path: `${index}-${"p".repeat(2_000)}-path-tail`,
			reason: `${"r".repeat(2_000)}-reason-tail`,
			relevantWhen: `${"w".repeat(2_000)}-condition-tail`,
		}));
		const expanded = renderedText(
			renderContextPruneResult(
				{ content: [{ type: "text", text: "applied" }], details: oversized },
				true,
				testTheme,
				undefined,
			),
		);
		expect(expanded.length).toBeLessThan(5_000);
		expect(expanded).not.toContain("path-tail");
		expect(expanded).not.toContain("reason-tail");

		const warning = renderedText(
			renderContextPruneResult(
				{ content: [{ type: "text", text: `${"x".repeat(10_000)}warning-tail` }], details: {} },
				false,
				testTheme,
				undefined,
			),
		);
		expect(warning.length).toBeLessThan(1_100);
		expect(warning).not.toContain("warning-tail");
	});

	it("renders applied warnings and malformed results as warnings", () => {
		const warningDetails = details();
		warningDetails.warnings.push("missing.ts: file not found");
		const warned = renderContextPruneResult(
			{ content: [{ type: "text", text: "Checkpoint applied with a warning" }], details: warningDetails },
			false,
			testTheme,
			undefined,
		);
		expect(renderedText(warned)).toContain("<warning>Checkpoint");
		expect(renderedText(warned)).toContain("warnings 1");

		const malformed = renderContextPruneResult(
			{ content: [{ type: "text", text: "bad details" }], details: {} },
			false,
			testTheme,
			undefined,
		);
		expect(renderedText(malformed)).toContain("<warning>bad details</warning>");
	});
});
