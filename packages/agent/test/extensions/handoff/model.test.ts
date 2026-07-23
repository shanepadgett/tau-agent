import { describe, expect, it } from "vitest";
import { buildHandoffRequest, handoffDraftFromToolInput } from "../../../extensions/handoff/model.ts";

describe("handoff model output", () => {
	it("normalizes a focused draft", () => {
		expect(
			handoffDraftFromToolInput({
				prompt: "  Continue the context work.  ",
				files: ["./src/context.ts", "@src/context.ts", "src/../src/index.ts"],
			}),
		).toEqual({ prompt: "Continue the context work.", files: ["src/context.ts", "src/index.ts"] });
	});

	it.each(["", "/tmp/secret", "C:/Users/me/secret", "../secret", "src/../../secret", "src\\secret.ts"])(
		"rejects invalid autoread path %j",
		(path) => {
			expect(() => handoffDraftFromToolInput({ prompt: "Continue.", files: [path] })).toThrow(
				"project-relative path",
			);
		},
	);

	it("grounds the generation request in the supplied conversation", () => {
		const request = buildHandoffRequest("Assistant: Read src/main.ts", "Finish the parser", "/repo");
		expect(request).toContain("Finish the parser");
		expect(request).toContain("Assistant: Read src/main.ts");
		expect(request).toContain("must already be known from the conversation");
	});
});
