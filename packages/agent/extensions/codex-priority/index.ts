import {
	calculateCost,
	clampThinkingLevel,
	createAssistantMessageEventStream,
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Model,
	type ModelThinkingLevel,
	type SimpleStreamOptions,
	type Usage,
} from "@earendil-works/pi-ai";
import { openAICodexResponsesApi } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PRIORITY_MODEL_ID = "gpt-6-luna";
// OpenAI documents Codex Fast mode as 2.5x credits for GPT-6 models. pi-ai applies 2x, so cost is recomputed.
const PRIORITY_MULTIPLIER = 2.5;

type CodexOptions = SimpleStreamOptions & {
	serviceTier?: "priority";
	reasoningEffort?: Exclude<ModelThinkingLevel, "off">;
};

function reprice(model: Model<Api>, usage: Usage): void {
	calculateCost(model, usage);
	usage.cost.input *= PRIORITY_MULTIPLIER;
	usage.cost.output *= PRIORITY_MULTIPLIER;
	usage.cost.cacheRead *= PRIORITY_MULTIPLIER;
	usage.cost.cacheWrite *= PRIORITY_MULTIPLIER;
	usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
}

function errorMessage(model: Model<Api>, error: unknown): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage: error instanceof Error ? error.message : String(error),
		timestamp: Date.now(),
	};
}

function withPriorityPricing(source: AssistantMessageEventStream, model: Model<Api>): AssistantMessageEventStream {
	const output = createAssistantMessageEventStream();
	void (async () => {
		try {
			for await (const event of source) {
				if (event.type === "done") reprice(model, event.message.usage);
				else if (event.type === "error") reprice(model, event.error.usage);
				output.push(event);
			}
			const result = await source.result();
			reprice(model, result.usage);
			output.end(result);
		} catch (error) {
			const message = errorMessage(model, error);
			output.push({ type: "error", reason: "error", error: message });
			output.end(message);
		}
	})();
	return output;
}

export default function codexPriorityExtension(pi: ExtensionAPI): void {
	const codex = openAICodexResponsesApi();
	// Overlay the built-in provider so its models and authentication stay intact. Pi routes both
	// stream() and streamSimple() for this API here, including the agent loop and registry calls.
	pi.registerProvider("openai-codex", {
		api: "openai-codex-responses",
		streamSimple(model, context, options) {
			const priority = model.id === PRIORITY_MODEL_ID;
			const request: CodexOptions = { ...options };
			// A stream() caller passes reasoningEffort itself; only derive it from the neutral option.
			if (options?.reasoning !== undefined) {
				const level = clampThinkingLevel(model, options.reasoning);
				request.reasoningEffort = level === "off" ? undefined : level;
			}
			if (priority) request.serviceTier = "priority";
			const stream = codex.stream(model, context, request);
			return priority ? withPriorityPricing(stream, model) : stream;
		},
	});
}
