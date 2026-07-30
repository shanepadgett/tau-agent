import { describe, expect, it } from "vitest";

import { commitEffort } from "../../../extensions/commit/commit-effort.ts";

describe("commit effort", () => {
	it("uses quick effort through 500 changed lines", () => {
		expect(commitEffort([{ changeSize: 300 }, { changeSize: 200 }])).toBe("quick");
	});

	it("uses standard effort above 500 changed lines", () => {
		expect(commitEffort([{ changeSize: 501 }])).toBe("standard");
	});

	it("uses standard effort for binary changes", () => {
		expect(commitEffort([{ changeSize: "binary" }])).toBe("standard");
	});
});
