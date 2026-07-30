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
				model("xai", "grok-4.5"),
				model("anthropic", "claude-opus-5"),
				model("anthropic", "claude-fable-5"),
			]),
			"deep",
		);

		expect(providers.map((provider) => provider.provider)).toEqual(["openai-codex", "anthropic"]);
		expect(providers[0]?.candidates.map((candidate) => [candidate.model.id, candidate.reasoning])).toEqual([
			["gpt-5.6-sol", "high"],
		]);
		expect(providers[1]?.candidates.map((candidate) => candidate.model.id)).toEqual([
			"claude-opus-5",
			"claude-fable-5",
		]);
		expect(providers[1]?.candidates.map((candidate) => candidate.reasoning)).toEqual(["high", "low"]);
	});

	it("only offers logged-in providers and available fallback models", () => {
		const providers = resolveEffortProviders(context([model("anthropic", "claude-fable-5")]), "deep");
		expect(providers).toHaveLength(1);
		expect(providers[0]?.provider).toBe("anthropic");
		expect(providers[0]?.candidates[0]?.model.id).toBe("claude-fable-5");
	});

	it("maps each tier to its configured thinking level", () => {
		const ctx = context([model("openai-codex", "gpt-5.6-luna"), model("openai-codex", "gpt-5.6-sol")]);
		expect(resolveEffortProviders(ctx, "quick")[0]?.candidates[0]?.reasoning).toBe("medium");
		expect(resolveEffortProviders(ctx, "standard")[0]?.candidates[0]?.reasoning).toBe("max");
		expect(resolveEffortProviders(ctx, "deep")[0]?.candidates[0]?.reasoning).toBe("high");
	});

	it("derives effort from the active provider, model, and thinking level", () => {
		expect(effortForSelection("openai-codex", "gpt-5.6-luna", "medium")).toBe("quick");
		expect(effortForSelection("openai-codex", "gpt-5.6-luna", "max")).toBe("standard");
		expect(effortForSelection("xai", "grok-4.5", "high")).toBe("standard");
		expect(effortForSelection("anthropic", "claude-fable-5", "low")).toBe("deep");
	});

	it("does not derive an effort for an incomplete or unrelated selection", () => {
		expect(effortForSelection(undefined, "gpt-5.6-sol", "high")).toBeUndefined();
		expect(effortForSelection("openai-codex", "gpt-5.6-sol", "medium")).toBeUndefined();
		expect(effortForSelection("other", "gpt-5.6-sol", "high")).toBeUndefined();
	});
});
