import { describe, expect, it } from "vitest";
import { rewriteXaiPayload } from "../../../extensions/xai/payload.ts";

describe("xAI Responses payload", () => {
	it("moves leading instructions and removes unsupported cache retention", () => {
		expect(
			rewriteXaiPayload({
				input: [
					{ role: "developer", content: [{ type: "input_text", text: "system" }] },
					{ role: "user", content: [{ type: "input_text", text: "hello" }] },
				],
				prompt_cache_retention: "24h",
				reasoning: { effort: "minimal", summary: "auto" },
			}),
		).toEqual({
			input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
			instructions: "system",
			reasoning: { effort: "low" },
		});
	});

	it("replays image tool output as a following user message", () => {
		const image = { type: "input_image", image_url: "data:image/png;base64,cG5n" };
		const result = rewriteXaiPayload({
			input: [
				{
					type: "function_call_output",
					call_id: "call-1",
					output: [{ type: "input_text", text: "saved" }, image],
				},
			],
		});
		expect(result).toEqual({
			input: [
				{ type: "function_call_output", call_id: "call-1", output: "saved" },
				{
					role: "user",
					content: [
						{
							type: "input_text",
							text: "The previous tool result included image output. Use the attached image.",
						},
						image,
					],
				},
			],
		});
	});
});
