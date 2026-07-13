import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { XAI_API_BASE_URL, XAI_CHAT_MODEL, XAI_PROVIDER } from "./constants.ts";
import { xaiOAuth } from "./oauth.ts";
import { rewriteXaiPayload } from "./payload.ts";

export default function xaiExtension(pi: ExtensionAPI): void {
	pi.registerProvider(XAI_PROVIDER, {
		name: "xAI (Grok subscription OAuth)",
		baseUrl: XAI_API_BASE_URL,
		api: "openai-responses",
		authHeader: true,
		oauth: xaiOAuth,
		models: [
			{
				id: XAI_CHAT_MODEL,
				name: "Grok 4.5",
				reasoning: true,
				input: ["text", "image"],
				cost: { input: 2, output: 6, cacheRead: 0.5, cacheWrite: 0 },
				contextWindow: 500_000,
				maxTokens: 131_072,
				thinkingLevelMap: {
					off: null,
					minimal: "low",
					low: "low",
					medium: "medium",
					high: "high",
					xhigh: null,
					max: null,
				},
			},
		],
	});
	pi.on("before_provider_request", (event, ctx) => {
		if (ctx.model?.provider !== XAI_PROVIDER) return;
		return rewriteXaiPayload(event.payload);
	});
}
