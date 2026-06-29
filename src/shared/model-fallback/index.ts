import type { Api, Message, Model, ThinkingLevel } from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadTauExtensionSettings, updateTauExtensionSettings } from "../settings/load.ts";
import { errorText, truncAt } from "../text.ts";
import modelFallbackSettings from "./settings.ts";
import type { ModelCandidate } from "./types.ts";

const MAX_ATTEMPTS = 5;
const SEVEN_DAYS_MS = 604_800_000;
const CHARS_PER_TOKEN_ESTIMATE = 4;
const MEDIUM_PROMPT_TOKENS = 4_000;
const LARGE_PROMPT_TOKENS = 16_000;

const PREFERRED_MODELS: ReadonlyArray<{ provider: string; model: string; reasoning: ThinkingLevel }> = [
	{ provider: "openrouter", model: "cohere/north-mini-code:free", reasoning: "high" },
	{ provider: "github-copilot", model: "gemini-3.5-flash", reasoning: "high" },
	{ provider: "openai-codex", model: "gpt-5.4-mini", reasoning: "high" },
	{ provider: "anthropic", model: "claude-haiku-4-5", reasoning: "high" },
];

const SMALL_PROMPT_MODELS: ReadonlyArray<{ provider: string; model: string; reasoning: ThinkingLevel }> = [
	{ provider: "openrouter", model: "cohere/north-mini-code:free", reasoning: "high" },
	{ provider: "github-copilot", model: "gemini-3.5-flash", reasoning: "high" },
	{ provider: "openai-codex", model: "gpt-5.4-mini", reasoning: "high" },
	{ provider: "openai-codex", model: "gpt-5.5", reasoning: "high" },
];

const MEDIUM_PROMPT_MODELS: ReadonlyArray<{ provider: string; model: string; reasoning: ThinkingLevel }> = [
	{ provider: "github-copilot", model: "gemini-3.5-flash", reasoning: "high" },
	{ provider: "openai-codex", model: "gpt-5.4-mini", reasoning: "high" },
	{ provider: "openai-codex", model: "gpt-5.5", reasoning: "high" },
];

const LARGE_PROMPT_MODELS: ReadonlyArray<{ provider: string; model: string; reasoning: ThinkingLevel }> = [
	{ provider: "openai-codex", model: "gpt-5.5", reasoning: "medium" },
];

interface GenerationContext {
	ui: ExtensionContext["ui"];
	signal: AbortSignal | undefined;
}

export async function resolveCandidates(
	ctx: Pick<ExtensionContext, "modelRegistry" | "model" | "cwd" | "isProjectTrusted">,
	preferredModels: ReadonlyArray<{ provider: string; model: string; reasoning: ThinkingLevel }> = PREFERRED_MODELS,
): Promise<ModelCandidate[]> {
	const settings = await loadTauExtensionSettings(ctx, modelFallbackSettings);
	const candidates: ModelCandidate[] = [];
	const seen = new Set<string>();
	const blocked = currentBlockedProviders(settings.cooldowns ?? {});

	const add = async (model: Model<Api>, reasoning: ThinkingLevel | undefined): Promise<void> => {
		if (blocked.has(model.provider)) return;
		const key = `${model.provider}/${model.id}`;
		if (seen.has(key)) return;

		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok || !auth.apiKey) return;

		seen.add(key);
		candidates.push({ model, apiKey: auth.apiKey, headers: auth.headers, reasoning });
	};

	for (const preferred of preferredModels) {
		const model = ctx.modelRegistry.find(preferred.provider, preferred.model);
		if (model) await add(model, preferred.reasoning);
	}
	if (ctx.model) await add(ctx.model, undefined);

	if (candidates.length === 0) throw new Error("No authenticated model available for generation.");
	return candidates;
}

export async function resolveCandidatesForPrompt(
	ctx: Pick<ExtensionContext, "modelRegistry" | "model" | "cwd" | "isProjectTrusted">,
	prompt: string,
): Promise<ModelCandidate[]> {
	return resolveCandidates(ctx, routedModelsForPrompt(prompt));
}

function routedModelsForPrompt(
	prompt: string,
): ReadonlyArray<{ provider: string; model: string; reasoning: ThinkingLevel }> {
	const tokens = Math.ceil(prompt.length / CHARS_PER_TOKEN_ESTIMATE);
	if (tokens < MEDIUM_PROMPT_TOKENS) return SMALL_PROMPT_MODELS;
	if (tokens < LARGE_PROMPT_TOKENS) return MEDIUM_PROMPT_MODELS;
	return LARGE_PROMPT_MODELS;
}

export async function generateValidated<T>(
	ctx: GenerationContext,
	candidates: readonly ModelCandidate[],
	prompt: string,
	validate: (text: string) => T,
	correctionPrompt?: (error: Error, text: string) => string,
	options?: { statusKey?: string; notifyOnFallback?: boolean },
): Promise<T> {
	const failures: string[] = [];
	const statusKey = options?.statusKey;
	const notifyOnFallback = options?.notifyOnFallback ?? false;

	for (const [index, candidate] of candidates.entries()) {
		const label = `${candidate.model.provider}/${candidate.model.id}`;
		if (statusKey) ctx.ui.setStatus(statusKey, `generating (${label})`);

		try {
			return await requestValidated(ctx, candidate, prompt, validate, correctionPrompt);
		} catch (error) {
			if (ctx.signal?.aborted) throw new Error("Cancelled.");
			if (shouldCooldownProvider(error)) await markProviderUnavailable(candidate.model.provider);
			const message = errorText(error);
			failures.push(`- ${label}: ${message}`);
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

	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
		const response = await completeSimple(
			candidate.model,
			{ messages },
			{ apiKey: candidate.apiKey, headers: candidate.headers, signal: ctx.signal, reasoning: candidate.reasoning },
		);

		if (response.stopReason === "aborted") throw new Error("Cancelled.");

		const text = response.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
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
