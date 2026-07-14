import { describe, expect, it } from "vitest";
import { ROK_SOUL } from "../../../extensions/soul/prompt.ts";

describe("Rok soul", () => {
	it("contains persona and operating rules without rebuilding Pi prompt sections", () => {
		expect(ROK_SOUL).toContain("## Tau persona");
		expect(ROK_SOUL).toContain("Build only what human specifically asked for");
		expect(ROK_SOUL).not.toContain("Available tools:");
		expect(ROK_SOUL).not.toContain("Pi documentation");
		expect(ROK_SOUL).not.toContain("Current working directory:");
	});
});
