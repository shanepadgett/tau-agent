import { Type, type Api, type AssistantMessage, type Model, type Tool } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";

const completeSimple = vi.hoisted(() => vi.fn<typeof import("@earendil-works/pi-ai/compat").completeSimple>());

vi.mock("@earendil-works/pi-ai/compat", () => ({ completeSimple }));

import { generateToolValidated, generateValidated } from "../../shared/model-fallback/index.ts";

const model = {
	id: "test-model",
	provider: "openai-codex",
} as Model<Api>;
const candidate = { model, apiKey: "key", headers: undefined, reasoning: undefined };
const ctx = { ui: {} as ExtensionContext["ui"], signal: undefined };

function response(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-codex-responses",
		provider: "openai-codex",
		model: "test-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}

function toolResponse(value: string): AssistantMessage {
	return {
		...response(""),
		content: [{ type: "toolCall", id: "call", name: "submit", arguments: { value } }],
	};
}

describe("model fallback", () => {
	beforeEach(() => completeSimple.mockReset());

	it("uses one isolated session ID per nested text generation", async () => {
		completeSimple.mockResolvedValueOnce(response("bad")).mockResolvedValueOnce(response("good"));

		await expect(
			generateValidated(
				ctx,
				[candidate],
				"prompt",
				(text) => {
					if (text === "bad") throw new Error("invalid");
					return text;
				},
				() => "correct it",
			),
		).resolves.toBe("good");

		const firstId = completeSimple.mock.calls[0]?.[2]?.sessionId;
		const retryId = completeSimple.mock.calls[1]?.[2]?.sessionId;
		expect(firstId).toBeTypeOf("string");
		expect(retryId).toBe(firstId);

		completeSimple.mockResolvedValueOnce(response("done"));
		await generateValidated(ctx, [candidate], "another prompt", (text) => text);
		expect(completeSimple.mock.calls[2]?.[2]?.sessionId).not.toBe(firstId);
	});

	it("uses one isolated session ID per nested tool generation", async () => {
		const tool = {
			name: "submit",
			description: "Submit the result",
			parameters: Type.Object({ value: Type.String() }),
		} satisfies Tool;
		completeSimple.mockResolvedValueOnce(toolResponse("bad")).mockResolvedValueOnce(toolResponse("good"));

		await expect(
			generateToolValidated(
				ctx,
				[candidate],
				"prompt",
				tool,
				(input) => {
					if (!input || typeof input !== "object" || !("value" in input) || input.value !== "good")
						throw new Error("invalid");
					return input.value;
				},
				() => "correct it",
			),
		).resolves.toBe("good");

		const firstId = completeSimple.mock.calls[0]?.[2]?.sessionId;
		expect(completeSimple.mock.calls[1]?.[2]?.sessionId).toBe(firstId);

		completeSimple.mockResolvedValueOnce(toolResponse("good"));
		await generateToolValidated(ctx, [candidate], "another prompt", tool, () => "good");
		expect(completeSimple.mock.calls[2]?.[2]?.sessionId).not.toBe(firstId);
	});
});
