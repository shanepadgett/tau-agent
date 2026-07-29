import { describe, expect, it } from "vitest";
import { referenceDisplayName } from "../../../extensions/reference/panel.ts";

describe("reference display names", () => {
	it("uses owner and repository from HTTPS and SSH remotes", () => {
		expect(referenceDisplayName("https://github.com/vercel/ai.git", "ai")).toBe("vercel/ai");
		expect(referenceDisplayName("git@github.com:vercel/ai.git", "ai")).toBe("vercel/ai");
	});

	it("works with other Git hosts and falls back without an owner", () => {
		expect(referenceDisplayName("https://codeberg.org/forgejo/forgejo.git", "forgejo")).toBe("forgejo/forgejo");
		expect(referenceDisplayName("/tmp/ai", "ai")).toBe("ai");
	});
});
