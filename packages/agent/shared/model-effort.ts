import type { Api, Model, ThinkingLevel } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveCandidates } from "./model-fallback/index.ts";
import type { ModelCandidate } from "./model-fallback/types.ts";

export type ModelEffort = "low" | "medium" | "high";

interface ModelPreference {
	model: string;
	reasoning: ThinkingLevel;
}

interface ProviderPreference {
	provider: string;
	models: readonly ModelPreference[];
}

export interface EffortProviderCandidates {
	provider: string;
	label: string;
	candidates: ReadonlyArray<{
		model: Model<Api>;
		reasoning: ThinkingLevel;
	}>;
}

const MODEL_PREFERENCES: Record<ModelEffort, readonly ProviderPreference[]> = {
	low: [
		{
			provider: "openai-codex",
			models: [
				{ model: "gpt-5.6-luna", reasoning: "high" },
				{ model: "gpt-5.5", reasoning: "low" },
			],
		},
		{ provider: "xai", models: [{ model: "grok-4.5", reasoning: "medium" }] },
		{ provider: "anthropic", models: [{ model: "claude-haiku-4-5", reasoning: "high" }] },
	],
	medium: [
		{
			provider: "openai-codex",
			models: [
				{ model: "gpt-5.6-terra", reasoning: "high" },
				{ model: "gpt-5.5", reasoning: "medium" },
			],
		},
		{ provider: "xai", models: [{ model: "grok-4.5", reasoning: "high" }] },
		{ provider: "anthropic", models: [{ model: "claude-sonnet-5", reasoning: "high" }] },
	],
	high: [
		{
			provider: "openai-codex",
			models: [
				{ model: "gpt-5.6-sol", reasoning: "high" },
				{ model: "gpt-5.5", reasoning: "high" },
			],
		},
		{ provider: "xai", models: [{ model: "grok-4.5", reasoning: "high" }] },
		{
			provider: "anthropic",
			models: [
				{ model: "claude-opus-5", reasoning: "high" },
				{ model: "claude-opus-4-8", reasoning: "high" },
			],
		},
	],
};

export function effortForSelection(
	provider: string | undefined,
	model: string | undefined,
	reasoning: string | undefined,
): ModelEffort | undefined {
	if (!provider || !model || !reasoning) return undefined;
	for (const effort of ["high", "medium", "low"] as const) {
		const preference = MODEL_PREFERENCES[effort].find((item) => item.provider === provider);
		if (preference?.models.some((item) => item.model === model && item.reasoning === reasoning)) return effort;
	}
	return undefined;
}

export function resolveEffortProviders(
	ctx: Pick<ExtensionContext, "modelRegistry">,
	effort: ModelEffort,
): EffortProviderCandidates[] {
	const available = new Map(ctx.modelRegistry.getAvailable().map((model) => [`${model.provider}/${model.id}`, model]));
	return MODEL_PREFERENCES[effort].flatMap((preference) => {
		const candidates = preference.models.flatMap(({ model, reasoning }) => {
			const availableModel = available.get(`${preference.provider}/${model}`);
			return availableModel ? [{ model: availableModel, reasoning }] : [];
		});
		return candidates.length
			? [
					{
						provider: preference.provider,
						label: ctx.modelRegistry.getProviderDisplayName(preference.provider),
						candidates,
					},
				]
			: [];
	});
}

export function resolveEffortCandidates(
	ctx: Pick<ExtensionContext, "modelRegistry" | "model" | "cwd" | "isProjectTrusted">,
	effort: ModelEffort,
	includeParentModel: boolean,
): Promise<ModelCandidate[]> {
	return resolveCandidates(
		ctx,
		MODEL_PREFERENCES[effort].flatMap((preference) =>
			preference.models.map((model) => ({ provider: preference.provider, ...model })),
		),
		includeParentModel,
	);
}
