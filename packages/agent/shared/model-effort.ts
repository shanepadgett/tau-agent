import type { Api, Model, ThinkingLevel } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveCandidates } from "./model-fallback/index.ts";
import type { ModelCandidate } from "./model-fallback/types.ts";

export type ModelEffort = "quick" | "standard" | "deep";

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

export interface EffortCandidateOptions {
	includeParentModel: boolean;
	preferredProvider?: string;
}

const MODEL_PREFERENCES: Record<ModelEffort, readonly ProviderPreference[]> = {
	quick: [
		{
			provider: "openai-codex",
			models: [
				{ model: "gpt-6-luna", reasoning: "medium" },
				{ model: "gpt-5.6-luna", reasoning: "medium" },
			],
		},
		{ provider: "xai", models: [{ model: "grok-4.7", reasoning: "medium" }] },
		{ provider: "anthropic", models: [{ model: "claude-sonnet-5", reasoning: "medium" }] },
	],
	standard: [
		{
			provider: "openai-codex",
			models: [
				{ model: "gpt-6-sol", reasoning: "high" },
				{ model: "gpt-6-luna", reasoning: "max" },
				{ model: "gpt-5.6-luna", reasoning: "max" },
			],
		},
		{ provider: "xai", models: [{ model: "grok-4.7", reasoning: "high" }] },
		{ provider: "anthropic", models: [{ model: "claude-sonnet-5", reasoning: "high" }] },
	],
	deep: [
		{
			provider: "openai-codex",
			models: [{ model: "gpt-6-astra", reasoning: "medium" }],
		},
		{
			provider: "anthropic",
			models: [
				{ model: "claude-opus-5.5", reasoning: "medium" },
				{ model: "claude-fable-5.1", reasoning: "low" },
			],
		},
	],
};

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
	options: EffortCandidateOptions,
): Promise<ModelCandidate[]> {
	const preferences = options.preferredProvider
		? [
				...MODEL_PREFERENCES[effort].filter(({ provider }) => provider === options.preferredProvider),
				...MODEL_PREFERENCES[effort].filter(({ provider }) => provider !== options.preferredProvider),
			]
		: MODEL_PREFERENCES[effort];
	return resolveCandidates(
		ctx,
		preferences.flatMap((preference) =>
			preference.models.map((model) => ({ provider: preference.provider, ...model })),
		),
		options.includeParentModel,
	);
}
