import type { Api, Model, ThinkingLevel } from "@earendil-works/pi-ai";

export interface ModelCandidate {
	model: Model<Api>;
	apiKey: string;
	headers: Record<string, string> | undefined;
	reasoning: ThinkingLevel | undefined;
}
