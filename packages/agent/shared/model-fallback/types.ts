import type { Api, Model, Provider, ProviderEnv, ProviderHeaders, ThinkingLevel } from "@earendil-works/pi-ai";

export interface ModelCandidate {
	model: Model<Api>;
	provider: Provider;
	apiKey: string | undefined;
	headers: ProviderHeaders | undefined;
	env: ProviderEnv | undefined;
	reasoning: ThinkingLevel | undefined;
}
