import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import sessionMemorySettings from "../../../extensions/session-memory/settings.ts";

describe("session-memory settings", () => {
	it("defaults tool rows to hidden", () => {
		expect(Value.Check(sessionMemorySettings.schema, sessionMemorySettings.defaults)).toBe(true);
		expect(sessionMemorySettings.defaults.showToolRows).toBe(false);
		expect(Object.keys(sessionMemorySettings.defaults)).toEqual(["enabled", "showToolRows", "contextCeilingTokens"]);
		expect(Value.Check(sessionMemorySettings.schema, { enabled: true, contextCeilingTokens: 30_000 })).toBe(false);
	});
});
