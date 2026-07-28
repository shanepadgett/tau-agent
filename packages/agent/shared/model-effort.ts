import type { ThinkingLevel } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveCandidates } from "./model-fallback/index.ts";
import type { ModelCandidate } from "./model-fallback/types.ts";

export type ModelEffort = "low" | "medium" | "high";

interface ModelPreference {
	provider: string;
	model: string;
	reasoning: ThinkingLevel;
}

const MODEL_PREFERENCES: Record<ModelEffort, readonly ModelPreference[]> = {
	low: [
		{ provider: "openai-codex", model: "gpt-5.6-luna", reasoning: "high" },
		{ provider: "xai", model: "grok-4.5", reasoning: "medium" },
		{ provider: "anthropic", model: "claude-haiku-4-5", reasoning: "high" },
	],
	medium: [
		{ provider: "openai-codex", model: "gpt-5.6-terra", reasoning: "high" },
		{ provider: "xai", model: "grok-4.5", reasoning: "high" },
		{ provider: "anthropic", model: "claude-sonnet-5", reasoning: "high" },
	],
	high: [
		{ provider: "openai-codex", model: "gpt-5.6-sol", reasoning: "high" },
		{ provider: "xai", model: "grok-4.5", reasoning: "high" },
		{ provider: "anthropic", model: "claude-opus-5", reasoning: "high" },
	],
};

export function resolveEffortCandidates(
	ctx: Pick<ExtensionContext, "modelRegistry" | "model" | "cwd" | "isProjectTrusted">,
	effort: ModelEffort,
	includeParentModel: boolean,
): Promise<ModelCandidate[]> {
	return resolveCandidates(ctx, MODEL_PREFERENCES[effort], includeParentModel);
}
