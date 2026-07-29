import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { effortForSelection, resolveEffortProviders } from "../../shared/model-effort.ts";

const model = (provider: string, id: string) => ({ provider, id }) as Model<Api>;

function context(models: Model<Api>[]) {
	return {
		modelRegistry: {
			getAvailable: () => models,
			getProviderDisplayName: (provider: string) => provider.toUpperCase(),
		},
	} as unknown as Pick<ExtensionContext, "modelRegistry">;
}

describe("model effort policy", () => {
	it("keeps provider and model fallback ranking", () => {
		const providers = resolveEffortProviders(
			context([
				model("openai-codex", "gpt-5.6-sol"),
				model("openai-codex", "gpt-5.5"),
				model("xai", "grok-4.5"),
				model("anthropic", "claude-opus-5"),
				model("anthropic", "claude-opus-4-8"),
			]),
			"high",
		);

		expect(providers.map((provider) => provider.provider)).toEqual(["openai-codex", "xai", "anthropic"]);
		expect(providers[0]?.candidates.map((candidate) => [candidate.model.id, candidate.reasoning])).toEqual([
			["gpt-5.6-sol", "high"],
			["gpt-5.5", "high"],
		]);
		expect(providers[2]?.candidates.map((candidate) => candidate.model.id)).toEqual([
			"claude-opus-5",
			"claude-opus-4-8",
		]);
	});

	it("only offers logged-in providers and available fallback models", () => {
		const providers = resolveEffortProviders(context([model("anthropic", "claude-opus-4-8")]), "high");
		expect(providers).toHaveLength(1);
		expect(providers[0]?.provider).toBe("anthropic");
		expect(providers[0]?.candidates[0]?.model.id).toBe("claude-opus-4-8");
	});

	it("maps the shared OpenAI fallback to each tier's thinking level", () => {
		const ctx = context([model("openai-codex", "gpt-5.5")]);
		expect(resolveEffortProviders(ctx, "low")[0]?.candidates[0]?.reasoning).toBe("low");
		expect(resolveEffortProviders(ctx, "medium")[0]?.candidates[0]?.reasoning).toBe("medium");
		expect(resolveEffortProviders(ctx, "high")[0]?.candidates[0]?.reasoning).toBe("high");
	});

	it("derives effort from the active provider, model, and thinking level", () => {
		expect(effortForSelection("openai-codex", "gpt-5.6-luna", "high")).toBe("low");
		expect(effortForSelection("openai-codex", "gpt-5.5", "medium")).toBe("medium");
		expect(effortForSelection("xai", "grok-4.5", "high")).toBe("high");
		expect(effortForSelection("anthropic", "claude-opus-4-8", "high")).toBe("high");
	});

	it("does not derive an effort for an incomplete or unrelated selection", () => {
		expect(effortForSelection(undefined, "gpt-5.6-sol", "high")).toBeUndefined();
		expect(effortForSelection("openai-codex", "gpt-5.6-sol", "medium")).toBeUndefined();
		expect(effortForSelection("other", "gpt-5.6-sol", "high")).toBeUndefined();
	});
});
