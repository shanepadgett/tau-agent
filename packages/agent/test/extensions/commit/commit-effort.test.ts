import { describe, expect, it } from "vitest";

import { commitEffort } from "../../../extensions/commit/commit-effort.ts";

describe("commit effort", () => {
	it("uses low effort through 500 changed lines", () => {
		expect(commitEffort([{ changeSize: 300 }, { changeSize: 200 }])).toBe("low");
	});

	it("uses medium effort above 500 changed lines", () => {
		expect(commitEffort([{ changeSize: 501 }])).toBe("medium");
	});

	it("uses medium effort for binary changes", () => {
		expect(commitEffort([{ changeSize: "binary" }])).toBe("medium");
	});
});
