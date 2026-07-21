import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { dailyCostFromJsonl, sessionCost } from "../../../extensions/footer/index.ts";

function usage(input: number, cost: number) {
	return {
		input,
		output: 2,
		cacheRead: 3,
		cacheWrite: 4,
		totalTokens: input + 9,
		cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
	};
}

describe("footer usage accounting", () => {
	it("counts assistant, tool, compaction, and branch-summary usage once", () => {
		const entries = [
			{ type: "message", message: { role: "assistant", usage: usage(10, 0.1) } },
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "subagent",
					usage: usage(20, 0.2),
					details: { usage: { input: 999, cost: 999 } },
				},
			},
			{ type: "compaction", usage: usage(30, 0.3) },
			{ type: "branch_summary", usage: usage(40, 0.4) },
		];
		const ctx = {
			sessionManager: { getEntries: () => entries },
		} as unknown as Pick<ExtensionContext, "sessionManager">;

		expect(sessionCost(ctx)).toEqual({
			input: 100,
			output: 8,
			cacheRead: 12,
			cacheWrite: 16,
			latestCacheHitRate: (3 / 17) * 100,
			cost: 1,
		});
	});

	it("scans every standard persisted usage source and deduplicates copied entries", () => {
		const timestamp = "2026-07-21T12:00:00.000Z";
		const records = [
			{
				type: "message",
				timestamp,
				message: {
					role: "assistant",
					provider: "p",
					model: "m",
					timestamp: Date.parse(timestamp),
					usage: usage(1, 0.1),
				},
			},
			{
				type: "message",
				timestamp,
				message: {
					role: "toolResult",
					toolName: "subagent",
					toolCallId: "call-1",
					timestamp: Date.parse(timestamp),
					usage: usage(2, 0.2),
					details: { usage: { cost: 99 } },
				},
			},
			{ type: "compaction", id: "compact-1", timestamp, usage: usage(3, 0.3) },
			{ type: "branch_summary", id: "branch-1", timestamp, usage: usage(4, 0.4) },
		];
		const raw = records.map((record) => JSON.stringify(record)).join("\n");
		const range = { startMs: Date.parse("2026-07-21T00:00:00.000Z"), endMs: Date.parse("2026-07-22T00:00:00.000Z") };
		const seen = new Set<string>();

		expect(dailyCostFromJsonl(raw, range, seen)).toBeCloseTo(1);
		expect(dailyCostFromJsonl(raw, range, seen)).toBe(0);
	});
});
