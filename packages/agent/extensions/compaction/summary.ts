import { randomUUID } from "node:crypto";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	convertToLlm,
	estimateTokens,
	generateSummaryWithUsage,
	SettingsManager,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { resolveEffortCandidates } from "../../shared/model-effort.ts";
import { errorText } from "../../shared/text.ts";

export async function resolveCompactionCandidates(ctx: ExtensionContext) {
	const session = ctx.model;
	if (!session) throw new Error("No model available for compaction");
	const candidates = (
		await resolveEffortCandidates(ctx, "quick", { includeParentModel: false }).catch(() => [])
	).filter(({ model }) => model.provider === session.provider && model.id !== session.id);
	// The current model remains the last resort; summaries never cross providers.
	candidates.push({ model: session, reasoning: ctx.thinkingLevel === "off" ? undefined : ctx.thinkingLevel });
	return candidates;
}

export function previousCompactionFiles(ctx: ExtensionContext) {
	const read = new Set<string>();
	const modified = new Set<string>();
	const previous = [...ctx.sessionManager.getBranch()].reverse().find((entry) => entry.type === "compaction");
	if (previous?.type === "compaction" && previous.details && typeof previous.details === "object") {
		const details = previous.details as { readFiles?: unknown; modifiedFiles?: unknown };
		if (Array.isArray(details.readFiles))
			for (const file of details.readFiles) if (typeof file === "string") read.add(file);
		if (Array.isArray(details.modifiedFiles))
			for (const file of details.modifiedFiles) if (typeof file === "string") modified.add(file);
	}
	return { read, modified };
}

export async function summarize(
	messages: Parameters<typeof convertToLlm>[0],
	agentHandoff: { id: string; toolCallId: string; text: string },
	ctx: ExtensionContext,
	signal: AbortSignal,
	pi: Pick<ExtensionAPI, "appendEntry">,
) {
	const session = ctx.model;
	if (!session) throw new Error("No model available for compaction");
	// Use only canonical projected content, never the raw branch's message bodies.
	const history = messages.flatMap<(typeof messages)[number]>((message) => {
		if (message.role === "system") return [];
		if (message.role === "custom" && message.customType === "tau.compaction.guidance") return [];
		if (message.role === "toolResult" && message.toolCallId === agentHandoff.toolCallId) return [];
		if (message.role === "assistant") {
			const content = message.content.filter(
				(part) => part.type !== "toolCall" || part.id !== agentHandoff.toolCallId,
			);
			return content.length ? [{ ...message, content }] : [];
		}
		return [message];
	});
	const { read, modified } = previousCompactionFiles(ctx);
	for (const message of history) {
		const calls =
			message.role === "assistant"
				? message.content.flatMap((part) => (part.type === "toolCall" ? [part] : []))
				: message.role === "toolResult"
					? (message.nestedCalls?.calls ?? [])
					: [];
		for (const call of calls) {
			const path = call.arguments?.path;
			if (typeof path !== "string") continue;
			if (call.name === "read") read.add(path);
			if (call.name === "write" || call.name === "edit") modified.add(path);
		}
	}
	const readFiles = [...read].filter((file) => !modified.has(file)).sort();
	const modifiedFiles = [...modified].sort();
	// Preserve what the user actually saw, not a summary's reconstruction of it.
	let lastDelivered = "";
	for (const message of [...history].reverse()) {
		if (message.role === "user") break;
		if (message.role !== "assistant") continue;
		lastDelivered = message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
		if (lastDelivered.trim()) break;
	}
	const settings = SettingsManager.create(ctx.cwd);
	const { reserveTokens } = settings.getCompactionSettings(session);
	const retry = settings.getRetrySettings();
	const candidates = await resolveCompactionCandidates(ctx);
	for (const { model, reasoning } of candidates) {
		const captured: { stopReason: AssistantMessage["stopReason"] | null } = { stopReason: null };
		try {
			signal.throwIfAborted();
			const result = await generateSummaryWithUsage(
				history,
				model,
				reserveTokens,
				undefined,
				undefined,
				signal,
				"Consolidate previous checkpoints rather than quoting or nesting them. Do not reproduce handoffs or Last delivered assistant message sections; Tau appends the current handoff and latest delivered assistant text verbatim.",
				undefined,
				reasoning,
				async (summaryModel, context, options) => {
					signal.throwIfAborted();
					// Check Pi's final serialized request, including its system and format prompts.
					const inputTokens =
						context.messages.reduce((total, message) => total + estimateTokens(message), 0) + 1024;
					const maxTokens = options?.maxTokens ?? 0;
					if (maxTokens <= 0 || inputTokens + maxTokens > summaryModel.contextWindow)
						throw new Error("Complete checkpoint input and output budget exceed the model window");
					const stream = ctx.modelRegistry.streamSimple(summaryModel, context, options);
					const response = await stream.result();
					signal.throwIfAborted();
					captured.stopReason = response.stopReason;
					if (response.stopReason !== "stop")
						pi.appendEntry("tau.compaction.failure", {
							handoffId: agentHandoff.id,
							provider: model.provider.slice(0, 200),
							model: model.id.slice(0, 200),
							reason: "response",
							stopReason: response.stopReason,
							inputTokens,
							maxTokens,
							textChars: response.content.reduce(
								(n, part) => n + (part.type === "text" ? part.text.length : 0),
								0,
							),
							thinkingChars: response.content.reduce(
								(n, part) => n + (part.type === "thinking" ? part.thinking.length : 0),
								0,
							),
							usage: {
								input: response.usage.input,
								output: response.usage.output,
								reasoning: response.usage.reasoning ?? null,
								cacheRead: response.usage.cacheRead,
								cacheWrite: response.usage.cacheWrite,
								totalTokens: response.usage.totalTokens,
							},
						});
					return stream;
				},
				undefined,
				retry,
			);
			signal.throwIfAborted();
			if (captured.stopReason !== "stop")
				throw new Error(`Incomplete checkpoint (${captured.stopReason ?? "missing response"})`);
			const durable = result.text.trim();
			if (!durable) throw new Error("Empty compaction summary");
			const handoff = agentHandoff.text;
			let summary = `## Durable context\n\n${durable}`;
			if (readFiles.length) summary += `\n\n<read-files>\n${readFiles.join("\n")}\n</read-files>`;
			if (modifiedFiles.length) summary += `\n\n<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`;
			if (lastDelivered.trim())
				summary += `\n\n## Last delivered assistant message\n\nAlready shown to the user. Do not repeat it. If it already answers the request, do not generate another conclusion. Continue only unfinished work.\n\n${lastDelivered}`;
			summary += `\n\n## Current handoff\n\n${handoff}`;
			ctx.ui.notify(`Compaction summarized with ${model.provider}/${model.id}`, "info");
			return {
				summary,
				usage: result.usage,
				details: {
					checkpointId: randomUUID(),
					handoffId: agentHandoff.id,
					handoff,
					readFiles,
					modifiedFiles,
				},
			};
		} catch (error) {
			if (signal.aborted || captured.stopReason === "aborted") throw error;
			ctx.ui.notify(`Compaction with ${model.provider}/${model.id} failed: ${errorText(error)}`, "warning");
		}
	}
	throw new Error("All compaction models failed");
}
