import { type Api, completeSimple, type Message, type Model, type ThinkingLevel } from "@earendil-works/pi-ai";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { updateTauExtensionSettings } from "../../shared/settings/load.ts";
import { errorText, truncAt } from "./message.ts";
import commitSettings from "./settings.ts";
import type { CommitCandidate } from "./types.ts";

const COMMIT_MODEL_MAX_ATTEMPTS = 5;
const SEVEN_DAYS_MS = 604_800_000;

const PREFERRED_COMMIT_MODELS: ReadonlyArray<{ provider: string; model: string; reasoning: ThinkingLevel }> = [
	{ provider: "openrouter", model: "cohere/north-mini-code:free", reasoning: "high" },
	{ provider: "github-copilot", model: "gemini-3.5-flash", reasoning: "high" },
	{ provider: "openai-codex", model: "gpt-5.4-mini", reasoning: "high" },
	{ provider: "anthropic", model: "claude-haiku-4-5", reasoning: "high" },
];

export async function resolveCandidates(
	ctx: ExtensionCommandContext,
	settings: typeof commitSettings.defaults,
): Promise<CommitCandidate[]> {
	const candidates: CommitCandidate[] = [];
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

	for (const preferred of PREFERRED_COMMIT_MODELS) {
		const model = ctx.modelRegistry.find(preferred.provider, preferred.model);
		if (model) await add(model, preferred.reasoning);
	}
	if (ctx.model) await add(ctx.model, undefined);

	if (candidates.length === 0) throw new Error("No authenticated model available for commit generation.");
	return candidates;
}

export async function generateValidated<T>(
	ctx: ExtensionCommandContext,
	candidates: readonly CommitCandidate[],
	prompt: string,
	validate: (text: string) => T,
	correctionPrompt: (error: Error, text: string) => string,
): Promise<T> {
	const failures: string[] = [];

	for (const [index, candidate] of candidates.entries()) {
		const label = `${candidate.model.provider}/${candidate.model.id}`;
		ctx.ui.setStatus("commit", `generating (${label})`);

		try {
			return await requestValidated(ctx, candidate, prompt, validate, correctionPrompt);
		} catch (error) {
			if (ctx.signal?.aborted) throw new Error("Commit cancelled.");
			if (shouldCooldownProvider(error)) await markProviderUnavailable(ctx, candidate.model.provider);
			const message = errorText(error);
			failures.push(`- ${label}: ${message}`);
			if (index < candidates.length - 1) {
				ctx.ui.notify(`Commit model failed (${label}): ${message}\nTrying next model.`, "info");
			}
		}
	}

	throw new Error(["Commit generation failed for all models:", ...failures].join("\n"));
}

async function requestValidated<T>(
	ctx: ExtensionCommandContext,
	candidate: CommitCandidate,
	prompt: string,
	validate: (text: string) => T,
	correctionPrompt: (error: Error, text: string) => string,
): Promise<T> {
	const userMessage: Message = { role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() };
	const messages: Message[] = [userMessage];

	for (let attempt = 1; attempt <= COMMIT_MODEL_MAX_ATTEMPTS; attempt++) {
		const response = await completeSimple(
			candidate.model,
			{ messages },
			{ apiKey: candidate.apiKey, headers: candidate.headers, signal: ctx.signal, reasoning: candidate.reasoning },
		);

		if (response.stopReason === "aborted") throw new Error("Commit cancelled.");

		const text = response.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
		if (response.stopReason === "error") {
			const error = new Error(response.errorMessage || "model returned an error");
			if (attempt < COMMIT_MODEL_MAX_ATTEMPTS && !shouldCooldownProvider(error)) continue;
			throw error;
		}

		try {
			return validate(text);
		} catch (error) {
			if (!(error instanceof Error) || attempt >= COMMIT_MODEL_MAX_ATTEMPTS) throw error;

			if (text) messages.push({ ...response, content: [{ type: "text", text }] });
			messages.push({
				role: "user",
				content: [{ type: "text", text: correctionPrompt(error, truncAt(text, 4_000)) }],
				timestamp: Date.now(),
			});
		}
	}

	throw new Error("Commit generation failed.");
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

async function markProviderUnavailable(ctx: ExtensionCommandContext, provider: string): Promise<void> {
	const until = provider === "github-copilot" ? nextMonthStartMs() : Date.now() + SEVEN_DAYS_MS;
	await updateTauExtensionSettings("global", ctx, commitSettings, (current) => {
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
