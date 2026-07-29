import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { EFFORT_STATE_TYPE, effortState, nextEffort, replayEffortState } from "../../../extensions/effort/state.ts";

const entry = (effort: "low" | "medium" | "high" | undefined) =>
	({ type: "custom", customType: EFFORT_STATE_TYPE, data: effortState(effort) }) as SessionEntry;

describe("effort state", () => {
	it("cycles from unset through all tiers", () => {
		expect(nextEffort(undefined)).toBe("low");
		expect(nextEffort("low")).toBe("medium");
		expect(nextEffort("medium")).toBe("high");
		expect(nextEffort("high")).toBe("low");
	});

	it("restores the latest persisted value, including manual clear", () => {
		expect(replayEffortState([entry("high")])).toBe("high");
		expect(replayEffortState([entry("high"), entry(undefined)])).toBeUndefined();
	});
});
