import type { Api, Model, ThinkingLevel } from "@earendil-works/pi-ai";

export interface ModelCandidate {
	model: Model<Api>;
	reasoning: ThinkingLevel | undefined;
}
