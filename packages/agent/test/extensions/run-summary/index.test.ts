import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import runSummaryExtension from "../../../extensions/run-summary/index.ts";

describe("run summary extension", () => {
	it("records run and subagent costs as a display-only entry", () => {
		const handlers = new Map<string, (event: unknown) => void>();
		const appendEntry = vi.fn();
		const pi = {
			registerEntryRenderer() {},
			appendEntry,
			on(name: string, handler: (event: unknown) => void) {
				handlers.set(name, handler);
			},
		} as unknown as ExtensionAPI;
		runSummaryExtension(pi);

		handlers.get("agent_start")?.({});
		handlers.get("agent_end")?.({
			messages: [
				{ role: "assistant", usage: { cost: { total: 0.12 } } },
				{ role: "toolResult", toolName: "subagent", details: { usage: { cost: 0.03 } } },
			],
		});
		expect(appendEntry).not.toHaveBeenCalled();
		handlers.get("agent_start")?.({});
		handlers.get("agent_end")?.({
			messages: [{ role: "assistant", usage: { cost: { total: 0.01 } } }],
		});
		handlers.get("agent_settled")?.({});

		expect(appendEntry).toHaveBeenCalledOnce();
		expect(appendEntry.mock.calls[0]?.[0]).toBe("tau.run-summary");
		expect(appendEntry.mock.calls[0]?.[1]).toMatchObject({
			runCost: 0.13,
			subagentCost: 0.03,
			totalCost: 0.16,
		});
	});
});
