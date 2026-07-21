import { describe, expect, it } from "vitest";
import { formatSubagentPanelMarkdown } from "../../../extensions/subagent/cmux-panel.ts";
import type { SubagentDetails } from "../../../extensions/subagent/run.ts";

const base = (): SubagentDetails => ({
	agent: "scout",
	threadId: "thread-1",
	status: "running",
	phase: "run",
	task: "Find the gate",
	model: "openai-codex/test",
	thinkingLevel: "high",
	toolCalls: 2,
	actions: [
		{ tool: "grep", summary: "grep FifoGate", error: false },
		{ tool: "read", summary: "read run.ts", error: false },
	],
	omittedActions: 0,
	omittedErrors: 0,
	usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
	durationMs: 1500,
	currentActivity: "read run.ts",
});

describe("formatSubagentPanelMarkdown", () => {
	it("renders identity, task, actions, and activity", () => {
		const md = formatSubagentPanelMarkdown(base());
		expect(md).toContain("# scout · thread-1");
		expect(md).toContain("`running · run`");
		expect(md).toContain("Find the gate");
		expect(md).toContain("- · grep FifoGate");
		expect(md).toContain("## Current");
		expect(md).toContain("read run.ts");
	});

	it("renders errors and response when present", () => {
		const details = base();
		details.status = "failed";
		details.error = "boom";
		details.response = "partial";
		details.currentActivity = undefined;
		const md = formatSubagentPanelMarkdown(details);
		expect(md).toContain("## Error");
		expect(md).toContain("boom");
		expect(md).toContain("## Response");
		expect(md).toContain("partial");
	});
});
