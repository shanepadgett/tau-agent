import type {
	ClassifierAnswer,
	ClassifierQuestion,
	JsonObject,
	ModelThinkingLevel as ThinkingLevel,
} from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export type DecisionFeature = "approval" | "answerFirst" | "routing";

export type DecisionResult =
	| { status: "ok"; answers: Record<string, ClassifierAnswer>; model: string; elapsedMs: number; cost: number }
	| {
			status: "disabled" | "unavailable" | "timeout" | "error";
			model: string | null;
			message: string;
			elapsedMs: number;
	  };

export interface DecisionClient {
	enabled(feature: DecisionFeature): boolean;
	classify(
		feature: DecisionFeature,
		ctx: ExtensionContext,
		state: JsonObject,
		questions: Record<string, ClassifierQuestion>,
	): Promise<DecisionResult>;
}

export interface DecisionUsage {
	feature: DecisionFeature;
	model: string;
	cost: number;
	elapsedMs: number;
	status: DecisionResult["status"];
}

export interface DecisionRoute {
	route: string;
	probabilities: Record<string, number>;
	model: string;
	thinking: ThinkingLevel;
	elapsedMs: number;
	status: DecisionResult["status"];
}
