import type { ClassifierApi, ClassifierModel, ClassifierQuestion, ClassifierAnswer } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { DecisionClient, DecisionResult, DecisionUsage } from "../../shared/decisions.ts";
import { emitTauEvent } from "../../shared/events.ts";
import settingsSpec from "./settings.ts";

type Settings = typeof settingsSpec.defaults;
const CANDIDATES = [
	{ family: "jev", provider: "typesafe", id: "jev-latest" },
	{ family: "jev", provider: "openrouter", id: "~typesafe/jev-latest" },
	{ family: "jev", provider: "opencode", id: "jev-1.13" },
	{ family: "jev", provider: "vercel-ai-gateway", id: "typesafe-ai/jev" },
	{ family: "jev", provider: "cloudflare-workers-ai", id: "typesafe/jev" },
	{ family: "luna", provider: "openai", id: "gpt-6-luna" },
	{ family: "luna", provider: "openrouter", id: "openai/gpt-6-luna-decisions" },
	{ family: "luna", provider: "vercel-ai-gateway", id: "openai/gpt-6-luna-decisions" },
] as const;

export async function selectClassifier(
	ctx: ExtensionContext,
	settings: Settings,
	signal: AbortSignal,
): Promise<{ family: "jev" | "luna"; model: ClassifierModel<ClassifierApi> } | undefined> {
	if (!settings.enabled) return undefined;
	const providers = new Map<string, readonly ClassifierModel<ClassifierApi>[]>();
	for (const candidate of CANDIDATES) {
		if (settings.classifier !== "auto" && candidate.family !== settings.classifier) continue;
		let models = providers.get(candidate.provider);
		if (!models) {
			models = await ctx.modelRegistry.getAvailableOfType("classifier", candidate.provider, { signal });
			providers.set(candidate.provider, models);
		}
		const model = models.find((model) => model.id === candidate.id);
		if (model) return { family: candidate.family, model };
	}
	return undefined;
}

function validAnswer(question: ClassifierQuestion, answer: ClassifierAnswer | undefined): boolean {
	if (!answer || question.type !== answer.type) return false;
	const probability = (value: number) => Number.isFinite(value) && value >= 0 && value <= 1;
	if (answer.type === "bool") return probability(answer.probability);
	if (answer.type === "score") return Number.isFinite(answer.score) && probability(answer.confidence);
	if (question.type !== "choice" || !Object.hasOwn(question.criteria, answer.choice)) return false;
	const values = Object.keys(question.criteria).map((key) => answer.probabilities[key]);
	return (
		values.every((value) => typeof value === "number" && probability(value)) &&
		Math.abs(values.reduce((sum, value) => sum + (value ?? 0), 0) - 1) < 0.02
	);
}

export function createDecisionClient(
	pi: ExtensionAPI,
	getSettings: () => Settings,
	sessionSignal: () => AbortSignal,
): DecisionClient {
	return {
		enabled(feature) {
			const settings = getSettings();
			return settings.enabled && settings[feature].enabled;
		},
		async classify(feature, ctx, state, questions) {
			const started = performance.now();
			let modelName: string | null = null;
			let cost = 0;
			const lifetime = sessionSignal();
			const timeout = AbortSignal.timeout(3000);
			const signal = AbortSignal.any([timeout, lifetime, ...(ctx.signal ? [ctx.signal] : [])]);
			const failure = (
				status: "disabled" | "unavailable" | "timeout" | "error",
				message: string,
			): DecisionResult => ({
				status,
				model: modelName,
				message,
				elapsedMs: Math.round(performance.now() - started),
			});
			if (!this.enabled(feature)) return failure("disabled", "Decision feature is off");
			let result: DecisionResult;
			let onAbort: () => void = () => {};
			try {
				const serialized = JSON.stringify({ state, questions });
				if (Buffer.byteLength(serialized) > 48000) return failure("unavailable", "Decision input is too large");
				const aborted = new Promise<never>((_resolve, reject) => {
					onAbort = () => reject(new Error("Decision cancelled"));
					signal.addEventListener("abort", onAbort, { once: true });
					if (signal.aborted) onAbort();
				});
				result = await Promise.race([
					aborted,
					(async (): Promise<DecisionResult> => {
						const model = (await selectClassifier(ctx, getSettings(), signal))?.model;
						if (signal.aborted) throw new Error("Decision cancelled");
						if (!model) return failure("unavailable", "No Jev or Luna credentials");
						modelName = `${model.provider}/${model.id}`;
						if (serialized.length / 3 > model.contextWindow)
							return failure("unavailable", "Decision input exceeds model window");
						const response = await ctx.modelRegistry.classify(
							model,
							{ state, questions },
							{ signal, timeoutMs: 3000, maxRetries: 0, maxRetryDelayMs: 0 },
						);
						if (signal.aborted) throw new Error("Decision cancelled");
						cost = response.usage?.cost.total ?? 0;
						if (
							response.stopReason !== "stop" ||
							!Object.entries(questions).every(([key, question]) => validAnswer(question, response.answers[key]))
						) {
							return failure("error", "Classifier returned no valid decision");
						}
						return {
							status: "ok",
							answers: response.answers,
							model: modelName,
							elapsedMs: Math.round(performance.now() - started),
							cost,
						};
					})(),
				]);
			} catch {
				result = failure(
					timeout.aborted ? "timeout" : "error",
					timeout.aborted ? "Decision timed out" : "Decision unavailable",
				);
			} finally {
				signal.removeEventListener("abort", onAbort);
			}
			if (modelName && !lifetime.aborted) {
				const usage: DecisionUsage = {
					feature,
					model: modelName,
					cost,
					elapsedMs: result.elapsedMs,
					status: result.status,
				};
				pi.appendEntry("tau.decisions.usage", usage);
				emitTauEvent(pi, "tau:decisions.usage", usage);
			}
			return result;
		},
	};
}
