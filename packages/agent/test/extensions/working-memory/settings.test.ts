import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import workingMemorySettings from "../../../extensions/working-memory/settings.ts";

describe("working-memory settings", () => {
	it("defaults to advisory 40k boundaries", () => {
		expect(workingMemorySettings.key).toBe("workingMemory");
		expect(workingMemorySettings.defaults.nudgeEveryTokens).toBe(40_000);
		expect(Value.Check(workingMemorySettings.schema, workingMemorySettings.defaults)).toBe(true);
	});
});
