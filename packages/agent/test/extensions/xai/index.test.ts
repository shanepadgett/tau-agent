import { createEventBus, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import xaiExtension from "../../../extensions/xai/index.ts";

describe("xAI extension", () => {
	it("registers only Grok 4.5 with OAuth", () => {
		const registerProvider = vi.fn();
		xaiExtension({ registerProvider, on: vi.fn(), events: createEventBus() } as unknown as ExtensionAPI);
		expect(registerProvider).toHaveBeenCalledOnce();
		expect(registerProvider).toHaveBeenCalledWith(
			"xai-oauth",
			expect.objectContaining({
				api: "openai-responses",
				authHeader: true,
				models: [expect.objectContaining({ id: "grok-4.5", contextWindow: 500_000 })],
				oauth: expect.objectContaining({ name: "xAI (Grok subscription)" }),
			}),
		);
	});
});
