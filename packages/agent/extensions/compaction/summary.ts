import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
	convertToLlm,
	estimateTokens,
	serializeConversation,
	SettingsManager,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { resolveEffortCandidates } from "../../shared/model-effort.ts";
import { errorText } from "../../shared/text.ts";

const SUMMARY_PROMPT = readFileSync(new URL("./prompts/summary.md", import.meta.url), "utf8");

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

export async function summarize(
	messages: Parameters<typeof convertToLlm>[0],
	agentHandoff: { id: string; toolCallId: string; text: string } | null,
	ctx: ExtensionContext,
	instructions: string | undefined,
	signal: AbortSignal,
) {
	const session = ctx.model;
	if (!session) throw new Error("No model available for compaction");
	// Use only canonical projected content, never the raw branch's message bodies.
	const history = messages.flatMap<(typeof messages)[number]>((message) => {
		if (message.role === "system") return [];
		if (message.role === "custom" && message.customType === "tau.compaction.guidance") return [];
		if (agentHandoff && message.role === "toolResult" && message.toolCallId === agentHandoff.toolCallId) return [];
		if (agentHandoff && message.role === "assistant") {
			const content = message.content.filter(
				(part) => part.type !== "toolCall" || part.id !== agentHandoff.toolCallId,
			);
			return content.length ? [{ ...message, content }] : [];
		}
		return [message];
	});
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
	const input = JSON.stringify({
		conversation: serializeConversation(convertToLlm(history)),
		agentHandoff: agentHandoff?.text ?? null,
		customInstructions: instructions ?? null,
	});
	const request = { role: "user" as const, content: [{ type: "text" as const, text: input }], timestamp: Date.now() };
	// Include serialization overhead, not the native preparation's split-history estimate.
	const inputTokens = estimateTokens(request) + Math.ceil(SUMMARY_PROMPT.length / 4) + 1024;
	const { reserveTokens } = SettingsManager.create(ctx.cwd).getCompactionSettings(session);
	const candidates = await resolveCompactionCandidates(ctx);
	for (const { model, reasoning } of candidates) {
		try {
			signal.throwIfAborted();
			const maxTokens = Math.min(Math.floor(0.8 * reserveTokens), model.maxTokens > 0 ? model.maxTokens : Infinity);
			if (maxTokens <= 0 || inputTokens + maxTokens > model.contextWindow)
				throw new Error("Complete checkpoint input and output budget exceed the model window");
			const response = await ctx.modelRegistry
				.streamSimple(
					model,
					{ systemPrompt: SUMMARY_PROMPT, messages: [request] },
					{
						maxTokens,
						signal,
						cacheRetention: "none",
						reasoning: model.reasoning ? reasoning : undefined,
					},
				)
				.result();
			signal.throwIfAborted();
			if (response.stopReason !== "stop" || response.content.some((part) => part.type === "toolCall"))
				throw new Error(response.errorMessage || `Incomplete checkpoint (${response.stopReason})`);
			const text = response.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
			const parsed: unknown = JSON.parse(text);
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid checkpoint");
			const parts = parsed as Record<string, unknown>;
			if (
				typeof parts.durableContext !== "string" ||
				!parts.durableContext.trim() ||
				(agentHandoff
					? parts.handoff !== null
					: typeof parts.handoff !== "string" || !parts.handoff.trim() || parts.handoff.length > 24000)
			)
				throw new Error("Checkpoint must contain durable context and exactly one current handoff");
			const handoff = agentHandoff ? agentHandoff.text : String(parts.handoff);
			let summary = `## Durable context\n\n${parts.durableContext.trim()}`;
			if (readFiles.length) summary += `\n\n<read-files>\n${readFiles.join("\n")}\n</read-files>`;
			if (modifiedFiles.length) summary += `\n\n<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`;
			summary += `\n\n## Current handoff\n\n${handoff}`;
			ctx.ui.notify(`Compaction summarized with ${model.provider}/${model.id}`, "info");
			return {
				summary,
				usage: response.usage,
				details: {
					checkpointId: randomUUID(),
					handoffId: agentHandoff?.id ?? null,
					handoff,
					readFiles,
					modifiedFiles,
				},
			};
		} catch (error) {
			if (signal.aborted) throw error;
			ctx.ui.notify(`Compaction with ${model.provider}/${model.id} failed: ${errorText(error)}`, "warning");
		}
	}
	throw new Error("All compaction models failed");
}
