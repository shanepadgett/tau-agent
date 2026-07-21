import { randomUUID } from "node:crypto";
import type { Api, AssistantMessage, Message, Model, ThinkingLevel, Tool } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadTauExtensionSettings, updateTauExtensionSettings } from "../settings/load.ts";
import { errorText, truncAt } from "../text.ts";
import modelFallbackSettings from "./settings.ts";
import type { ModelCandidate } from "./types.ts";

const MAX_ATTEMPTS = 5;
const MAX_TOOL_ATTEMPTS = 2;
const SEVEN_DAYS_MS = 604_800_000;

interface GenerationContext {
	ui: ExtensionContext["ui"];
	signal: AbortSignal | undefined;
}

interface ModelFallbackOptions {
	statusKey?: string;
	notifyOnFallback?: boolean;
	maxAttempts?: number;
	onStatus?: (status: string) => void | Promise<void>;
}

export async function resolveCandidates(
	ctx: Pick<ExtensionContext, "modelRegistry" | "model" | "cwd" | "isProjectTrusted">,
	preferredModels: ReadonlyArray<{ provider: string; model: string; reasoning: ThinkingLevel }>,
	includeParentModel: boolean,
): Promise<ModelCandidate[]> {
	const settings = await loadTauExtensionSettings(ctx, modelFallbackSettings);
	const candidates: ModelCandidate[] = [];
	const seen = new Set<string>();
	const blocked = currentBlockedProviders(settings.cooldowns ?? {});

	const add = async (model: Model<Api>, reasoning: ThinkingLevel | undefined): Promise<void> => {
		if (blocked.has(model.provider)) return;
		const key = `${model.provider}/${model.id}`;
		if (seen.has(key)) return;

		const provider = ctx.modelRegistry.getProvider(model.provider);
		if (!provider) return;
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok) return;

		seen.add(key);
		candidates.push({
			model,
			provider,
			apiKey: auth.apiKey,
			headers: auth.headers,
			env: auth.env,
			reasoning,
		});
	};

	for (const preferred of preferredModels) {
		const model = ctx.modelRegistry.find(preferred.provider, preferred.model);
		if (model) await add(model, preferred.reasoning);
	}
	if (includeParentModel && ctx.model) await add(ctx.model, undefined);

	if (candidates.length === 0) throw new Error("No authenticated model available for generation.");
	return candidates;
}

export async function generateValidated<T>(
	ctx: GenerationContext,
	candidates: readonly ModelCandidate[],
	prompt: string,
	validate: (text: string) => T,
	correctionPrompt?: (error: Error, text: string) => string,
	options?: ModelFallbackOptions,
): Promise<T> {
	return withModelFallback(ctx, candidates, options, (candidate) =>
		requestValidated(ctx, candidate, prompt, validate, correctionPrompt),
	);
}

export async function generateToolValidated<T>(
	ctx: GenerationContext,
	candidates: readonly ModelCandidate[],
	prompt: string,
	tool: Tool,
	validate: (input: unknown) => T,
	correctionPrompt?: (error: Error, output: string) => string,
	options?: ModelFallbackOptions,
): Promise<T> {
	return withModelFallback(ctx, candidates, options, (candidate) =>
		requestToolValidated(
			ctx,
			candidate,
			prompt,
			tool,
			validate,
			correctionPrompt,
			options?.maxAttempts ?? MAX_TOOL_ATTEMPTS,
		),
	);
}

async function withModelFallback<T>(
	ctx: GenerationContext,
	candidates: readonly ModelCandidate[],
	options: ModelFallbackOptions | undefined,
	request: (candidate: ModelCandidate) => Promise<T>,
): Promise<T> {
	const failures: string[] = [];
	const statusKey = options?.statusKey;
	const notifyOnFallback = options?.notifyOnFallback ?? false;

	for (const [index, candidate] of candidates.entries()) {
		const label = `${candidate.model.provider}/${candidate.model.id}`;
		if (statusKey) ctx.ui.setStatus(statusKey, `generating (${label})`);
		await options?.onStatus?.(`Generating with ${label}`);

		try {
			return await request(candidate);
		} catch (error) {
			if (ctx.signal?.aborted) throw new Error("Cancelled.");
			if (shouldCooldownProvider(error)) await markProviderUnavailable(candidate.model.provider);
			const message = errorText(error);
			failures.push(`- ${label}: ${message}`);
			if (index < candidates.length - 1) await options?.onStatus?.(`Model failed (${label}); trying next model`);
			if (index < candidates.length - 1 && notifyOnFallback) {
				ctx.ui.notify(`Model failed (${label}): ${message}\nTrying next model.`, "info");
			}
		}
	}

	throw new Error(["Model generation failed for all candidates:", ...failures].join("\n"));
}

async function requestValidated<T>(
	ctx: GenerationContext,
	candidate: ModelCandidate,
	prompt: string,
	validate: (text: string) => T,
	correctionPrompt?: (error: Error, text: string) => string,
): Promise<T> {
	const userMessage: Message = { role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() };
	const messages: Message[] = [userMessage];
	const sessionId = randomUUID();

	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
		const response = await completeCandidate(ctx, candidate, messages, sessionId);
		const text = responseText(response);
		if (response.stopReason === "error") {
			const error = new Error(response.errorMessage || "model returned an error");
			if (attempt < MAX_ATTEMPTS && !shouldCooldownProvider(error)) continue;
			throw error;
		}

		try {
			return validate(text);
		} catch (error) {
			if (!(error instanceof Error) || attempt >= MAX_ATTEMPTS) throw error;
			if (!correctionPrompt) throw error;

			if (text) messages.push({ ...response, content: [{ type: "text", text }] });
			messages.push({
				role: "user",
				content: [{ type: "text", text: correctionPrompt(error, truncAt(text, 4_000)) }],
				timestamp: Date.now(),
			});
		}
	}

	throw new Error("Model generation failed.");
}

async function requestToolValidated<T>(
	ctx: GenerationContext,
	candidate: ModelCandidate,
	prompt: string,
	tool: Tool,
	validate: (input: unknown) => T,
	correctionPrompt?: (error: Error, output: string) => string,
	maxAttempts = MAX_TOOL_ATTEMPTS,
): Promise<T> {
	const messages: Message[] = [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }];
	const sessionId = randomUUID();

	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		const response = await completeCandidate(ctx, candidate, messages, sessionId, [tool]);
		const text = responseText(response);
		const toolCalls = response.content.flatMap((part) => (part.type === "toolCall" ? [part] : []));
		const output = text || formatToolCalls(toolCalls);
		if (response.stopReason === "error") {
			const error = new Error(response.errorMessage || "model returned an error");
			if (attempt < maxAttempts && !shouldCooldownProvider(error)) continue;
			throw error;
		}

		try {
			if (toolCalls.length !== 1) throw new Error(`Model must call ${tool.name} exactly once.`);
			const [toolCall] = toolCalls;
			if (!toolCall) throw new Error(`Model must call ${tool.name}.`);
			if (toolCall.name !== tool.name) throw new Error(`Model called ${toolCall.name}; expected ${tool.name}.`);
			return validate(toolCall.arguments);
		} catch (error) {
			if (!(error instanceof Error) || attempt >= maxAttempts) throw error;
			if (!correctionPrompt) throw error;

			messages.push({
				role: "user",
				content: [{ type: "text", text: correctionPrompt(error, truncAt(output, 4_000)) }],
				timestamp: Date.now(),
			});
		}
	}

	throw new Error("Model generation failed.");
}

function completeCandidate(
	ctx: GenerationContext,
	candidate: ModelCandidate,
	messages: readonly Message[],
	sessionId: string,
	tools?: Tool[],
): Promise<AssistantMessage> {
	return candidate.provider
		.streamSimple(candidate.model, tools ? { messages: [...messages], tools } : { messages: [...messages] }, {
			apiKey: candidate.apiKey,
			headers: candidate.headers,
			env: candidate.env,
			signal: ctx.signal,
			reasoning: candidate.reasoning,
			sessionId,
		})
		.result();
}

function responseText(response: AssistantMessage): string {
	if (response.stopReason === "aborted") throw new Error("Cancelled.");
	return response.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
}

function formatToolCalls(toolCalls: readonly { name: string; arguments: unknown }[]): string {
	if (toolCalls.length === 0) return "(no tool call)";
	try {
		return JSON.stringify(
			toolCalls.map((call) => ({ name: call.name, arguments: call.arguments })),
			null,
			2,
		);
	} catch {
		return "(tool call arguments unavailable)";
	}
}

function shouldCooldownProvider(error: unknown): boolean {
	const message = errorText(error).toLowerCase();
	return [
		"401",
		"402",
		"403",
		"429",
		"api key",
		"authentication",
		"balance",
		"billing",
		"credit",
		"forbidden",
		"insufficient",
		"payment",
		"quota",
		"rate limit",
		"rate_limit",
		"unauthorized",
	].some((marker) => message.includes(marker));
}

function currentBlockedProviders(cooldowns: Record<string, number>): Set<string> {
	const now = Date.now();
	const blocked = new Set<string>();
	for (const [provider, availableAt] of Object.entries(cooldowns)) {
		if (availableAt > now) blocked.add(provider);
	}
	return blocked;
}

async function markProviderUnavailable(provider: string): Promise<void> {
	const until = provider === "github-copilot" ? nextMonthStartMs() : Date.now() + SEVEN_DAYS_MS;
	await updateTauExtensionSettings("global", { cwd: process.cwd() }, modelFallbackSettings, (current) => {
		const cooldowns: Record<string, number> = { ...(current.cooldowns ?? {}) };
		cooldowns[provider] = until;
		return { ...current, cooldowns };
	});
}

function nextMonthStartMs(): number {
	const next = new Date();
	next.setMonth(next.getMonth() + 1, 1);
	next.setHours(0, 0, 0, 0);
	return next.getTime();
}
