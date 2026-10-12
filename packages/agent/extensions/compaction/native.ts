import { compact, estimateTokens, SettingsManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { errorText } from "../../shared/text.ts";
import { resolveCompactionCandidates } from "./summary.ts";

export function registerNativeCompaction(pi: ExtensionAPI): void {
	pi.on("session_before_compact", async (event, ctx) => {
		const candidates = await resolveCompactionCandidates(ctx);
		const retry = SettingsManager.create(ctx.cwd).getRetrySettings();
		for (const { model, reasoning } of candidates) {
			try {
				event.signal.throwIfAborted();
				const result = await compact(
					event.preparation,
					model,
					undefined,
					undefined,
					event.customInstructions,
					event.signal,
					reasoning,
					(summaryModel, context, options) => {
						const inputTokens = context.messages.reduce((total, message) => total + estimateTokens(message), 0);
						if (inputTokens + (options?.maxTokens ?? 0) > summaryModel.contextWindow)
							throw new Error("Compaction input and output budget exceed the model window");
						return ctx.modelRegistry.streamSimple(summaryModel, context, options);
					},
					undefined,
					retry,
				);
				event.signal.throwIfAborted();
				ctx.ui.notify(`Compaction summarized with ${model.provider}/${model.id}`, "info");
				return { compaction: result };
			} catch (error) {
				if (event.signal.aborted) return { cancel: true };
				ctx.ui.notify(`Compaction with ${model.provider}/${model.id} failed: ${errorText(error)}`, "warning");
			}
		}
		ctx.ui.notify("Quick-model compaction failed; trying Pi compaction.", "warning");
		return undefined;
	});
}
