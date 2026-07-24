import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import contextPruningSettings from "../../../extensions/context-pruning/settings.ts";

function settingsWith(nudgeInstructions: string[]) {
	return { ...contextPruningSettings.defaults, nudgeInstructions };
}

describe("context pruning settings", () => {
	it("accepts one through five bounded nudge instructions", () => {
		expect(Value.Check(contextPruningSettings.schema, settingsWith(["only"]))).toBe(true);
		expect(Value.Check(contextPruningSettings.schema, settingsWith(["one", "two", "three", "four", "five"]))).toBe(
			true,
		);
	});

	it("rejects empty, oversized, empty-string, and overlong nudge instruction lists", () => {
		expect(Value.Check(contextPruningSettings.schema, settingsWith([]))).toBe(false);
		expect(Value.Check(contextPruningSettings.schema, settingsWith(["1", "2", "3", "4", "5", "6"]))).toBe(false);
		expect(Value.Check(contextPruningSettings.schema, settingsWith([""]))).toBe(false);
		expect(Value.Check(contextPruningSettings.schema, settingsWith(["x".repeat(2_001)]))).toBe(false);
	});
});
