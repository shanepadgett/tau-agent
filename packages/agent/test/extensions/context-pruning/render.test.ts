import { describe, expect, it } from "vitest";
import {
	parseContextPruningNudgeDetailsV1,
	renderContextPruneCall,
	renderContextPruneResult,
	renderContextPruningNudge,
} from "../../../extensions/context-pruning/render.ts";
import type { ContextPruneDetailsV1 } from "../../../shared/context-pruning-state.ts";
import { renderedText, testRowState, testTheme } from "../explore/helpers.ts";

function details(status: "applied" | "skipped" = "applied"): ContextPruneDetailsV1 {
	return {
		v: 1,
		status,
		anchorToolCallId: "anchor",
		newlyPrunedToolCallIds: status === "applied" ? ["grep-1", "read-2"] : [],
		newlyPrunedAutoreadRowIds: status === "applied" ? ["auto-1"] : [],
		retainedToolCallIds: ["patch-1"],
		retainedAutoreadRowIds: [],
		refreshedFiles: [{ path: "src/current.ts", rowId: "anchor:0", servedHash: "hash" }],
		deferredFiles: [{ path: "src/later.ts", reason: "cold", relevantWhen: "fallback fails" }],
		tokensBefore: 10_000,
		tokensAfter: 1_000,
		tokensReclaimed: 9_000,
	};
}

describe("context prune rendering", () => {
	it("renders informational, pressure, and manual context markers from strict details", () => {
		const automatic = {
			v: 1 as const,
			kind: "automatic" as const,
			percent: 40,
			boundary: 40,
			pressure: false,
			anchorToolCallId: null,
			growthBaselinePercent: 0,
		};
		const informational = renderedText(renderContextPruningNudge(automatic, testTheme));
		expect(informational).toContain("Context:");
		expect(informational).toContain("40%");
		const pressure = renderedText(
			renderContextPruningNudge({ ...automatic, percent: 61, boundary: 60, pressure: true }, testTheme),
		);
		expect(pressure).toContain("Context:");
		expect(pressure).toContain("61%");
		expect(pressure).toContain("Prune suggested.");
		const manual = renderedText(
			renderContextPruningNudge(
				{
					...automatic,
					kind: "manual",
					percent: null,
					boundary: null,
					growthBaselinePercent: null,
				},
				testTheme,
			),
		);
		expect(manual).toContain("Context:");
		expect(manual).toContain("Prune requested.");
		expect(parseContextPruningNudgeDetailsV1({ ...automatic, extra: true })).toBeUndefined();
		expect(renderContextPruningNudge({ ...automatic, percent: 101 }, testTheme)).toBeUndefined();
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
		expect(renderedText(result)).toContain("Pruned 3 · retained 1 · refreshed 1 · deferred 1");
		expect(renderedText(result)).not.toContain("grep-1");
	});

	it("lists bounded IDs and paths only when expanded", () => {
		const many = details();
		many.newlyPrunedToolCallIds = Array.from({ length: 30 }, (_, index) => `tool-${index}`);
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

	it("renders skipped and malformed results as warnings", () => {
		const skipped = renderContextPruneResult(
			{ content: [{ type: "text", text: "Prune skipped: too small" }], details: details("skipped") },
			false,
			testTheme,
			undefined,
		);
		expect(renderedText(skipped)).toContain("<warning>Prune skipped: too small</warning>");

		const malformed = renderContextPruneResult(
			{ content: [{ type: "text", text: "bad details" }], details: {} },
			false,
			testTheme,
			undefined,
		);
		expect(renderedText(malformed)).toContain("<warning>bad details</warning>");
	});
});
