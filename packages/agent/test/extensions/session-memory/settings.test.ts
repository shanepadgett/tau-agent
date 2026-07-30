import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import sessionMemorySettings from "../../../extensions/session-memory/settings.ts";

describe("session-memory settings", () => {
	it("keeps only the enabled switch and context ceiling configurable", () => {
		expect(Value.Check(sessionMemorySettings.schema, sessionMemorySettings.defaults)).toBe(true);
		expect(Object.keys(sessionMemorySettings.defaults)).toEqual(["enabled", "contextCeilingTokens"]);
		expect(Value.Check(sessionMemorySettings.schema, { enabled: true, contextCeilingTokens: 30_000 })).toBe(false);
	});
});
