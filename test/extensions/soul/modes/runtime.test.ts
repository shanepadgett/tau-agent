import type { ContextEvent, SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { applyActiveModeContext, deriveActiveMode } from "../../../../src/extensions/soul/modes/runtime.ts";

const modes = [
	{ kind: "debug-mode", verb: "debugging", description: "Debug", text: "Debug context" },
	{ kind: "plan-mode", verb: "planning", description: "Plan", text: "Plan context" },
] as const;

describe("soul mode runtime", () => {
	it("derives active mode from branch state entries", () => {
		expect(deriveActiveMode([modeState("debug-mode")], modes)).toEqual({
			modeKind: "debug-mode",
			verb: "debugging",
			content: "Debug context",
		});

		expect(deriveActiveMode([modeState("debug-mode"), modeState(null)], modes)).toBeUndefined();
		expect(deriveActiveMode([modeState("debug-mode"), modeState("plan-mode")], modes)).toEqual({
			modeKind: "plan-mode",
			verb: "planning",
			content: "Plan context",
		});
	});

	it("injects active mode context even when the stored mode message is gone", () => {
		const active = deriveActiveMode([modeState("debug-mode")], modes);
		if (!active) throw new Error("expected active mode");

		const messages: ContextEvent["messages"] = [
			{
				role: "custom",
				customType: "tau:soul.marker",
				content: "debugging enabled",
				display: true,
				timestamp: 1,
			},
			{
				role: "custom",
				customType: "tau:soul.mode",
				content: "Legacy mode context",
				display: false,
				timestamp: 1,
			},
			{ role: "user", content: "find bug", timestamp: 1 },
		];

		const result = applyActiveModeContext(messages, active);

		expect(result).toHaveLength(2);
		expect(result.at(0)).toMatchObject({
			role: "custom",
			customType: "tau:soul.mode-context",
			content: "Debug context",
			display: false,
		});
		expect(result.at(1)).toEqual({ role: "user", content: "find bug", timestamp: 1 });
	});
});

function modeState(modeKind: string | null): SessionEntry {
	return {
		type: "custom",
		id: `mode-state-${modeKind ?? "off"}`,
		parentId: null,
		timestamp: "2026-06-29T00:00:00.000Z",
		customType: "tau:soul.mode-state",
		data: { modeKind },
	};
}
