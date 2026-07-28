import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import subagentSettings from "../../../extensions/subagent/settings.ts";

describe("subagent settings", () => {
	it("defaults to all agents enabled", () => {
		expect(subagentSettings.key).toBe("subagent");
		expect(subagentSettings.defaults.disabled).toEqual([]);
		expect(Value.Check(subagentSettings.schema, subagentSettings.defaults)).toBe(true);
	});
});
