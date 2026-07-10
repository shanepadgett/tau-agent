import { describe, expect, it } from "vitest";
import { normalizeBranchName } from "../../../src/extensions/branch/index.ts";

describe("branch name normalization", () => {
	it("keeps lowercase hyphenated names", () => {
		expect(normalizeBranchName("add-branch-command")).toBe("add-branch-command");
	});

	it("lowercases and cleans sentences", () => {
		expect(normalizeBranchName("Fix login. Please")).toBe("fix-login-please");
	});

	it("collapses repeated punctuation and whitespace", () => {
		expect(normalizeBranchName("fix...   login___please")).toBe("fix-login-please");
	});

	it("trims surrounding separators", () => {
		expect(normalizeBranchName(" -- Add login! -- ")).toBe("add-login");
	});

	it("returns empty for input without letters or numbers", () => {
		expect(normalizeBranchName(" ... --- ")).toBe("");
	});
});
