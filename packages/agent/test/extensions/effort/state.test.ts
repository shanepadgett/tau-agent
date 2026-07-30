import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { EFFORT_STATE_TYPE, effortState, nextEffort, replayEffortState } from "../../../extensions/effort/state.ts";

const entry = (effort: "quick" | "standard" | "deep" | undefined) =>
	({ type: "custom", customType: EFFORT_STATE_TYPE, data: effortState(effort) }) as SessionEntry;

describe("effort state", () => {
	it("cycles from unset through all tiers", () => {
		expect(nextEffort(undefined)).toBe("quick");
		expect(nextEffort("quick")).toBe("standard");
		expect(nextEffort("standard")).toBe("deep");
		expect(nextEffort("deep")).toBe("quick");
	});

	it("restores the latest persisted value, including manual clear", () => {
		expect(replayEffortState([entry("deep")])).toBe("deep");
		expect(replayEffortState([entry("deep"), entry(undefined)])).toBeUndefined();
	});
});
