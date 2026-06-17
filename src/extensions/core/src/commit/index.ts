import { randomUUID } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Api, complete, type Message, type Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { createGitRunner, type GitRunner } from "../../../../shared/git.ts";

const COMMIT_TIMEOUT_MS = 120_000;
const PUSH_TIMEOUT_MS = 120_000;
const MAX_DIFF_CHARS = 80_000;
const MAX_UNTRACKED_FILES = 12;
const MAX_UNTRACKED_FILE_CHARS = 6_000;
const MAX_UNTRACKED_CONTENT_CHARS = 30_000;
const COMMIT_MARKER_TYPE = "tau.commit";
const COMMIT_PROVIDER_COOLDOWN_TYPE = "tau.commit.provider-cooldown";
const COMMIT_PROVIDER_COOLDOWN_MS = 86_400_000; // 1 day
const CONVENTIONAL_COMMIT_TYPES = new Set([
	"feat",
	"fix",
	"docs",
	"refactor",
	"test",
	"chore",
	"perf",
	"ci",
	"build",
	"revert",
]);

interface CommitMarker {
	hash: string;
	subject: string;
	timestamp: number;
}

interface CommitProviderCooldown {
	provider: string;
	failedAt: number;
	expiresAt: number;
	reason: string;
}

const COMMIT_MODEL_TIERS = [
	{ provider: "github-copilot", model: "gemini-3.5-flash", reasoning: "high" },
	{ provider: "github-copilot", model: "gpt-5.4-mini", reasoning: "high" },
	{ provider: "github-copilot", model: "claude-haiku-4.5", reasoning: "high" },
	{ provider: "openai-codex", model: "gpt-5.4-mini", reasoning: "high" },
	{ provider: "anthropic", model: "claude-haiku-4-5", reasoning: "high" },
] as const;

export function registerCommit(pi: ExtensionAPI): void {
	pi.registerCommand("commit", {
		description: "Generate a commit message and commit all changes",
		handler: async (_args, ctx) => {
			await ctx.waitForIdle();
			ctx.ui.setStatus("commit", "preparing commit");

			try {
				const git = createGitRunner(pi, ctx);
				const root = await git.run(["rev-parse", "--show-toplevel"], true);
				if (!root) {
					ctx.ui.notify("No git repository found.", "info");
					return;
				}
				git.cwd = root;

				const status = await git.run(["status", "--porcelain=v1", "--untracked-files=all"]);
				if (!status) {
					ctx.ui.notify("No uncommitted changes detected.", "info");
					return;
				}

				const evidence = await collectCommitEvidence(git, ctx.signal);
				const intentMessages = collectCommitIntent(ctx.sessionManager.getBranch());
				const commitModels = await resolveCommitModels(ctx);
				const providerCooldowns = collectActiveCommitProviderCooldowns(ctx.sessionManager.getBranch(), Date.now());
				const generatedMessage = await generateCommitMessageWithFallback(
					pi,
					ctx,
					applyCommitProviderCooldowns(commitModels, providerCooldowns),
					buildCommitPrompt(status, evidence, intentMessages),
				);

				const message = ctx.hasUI ? await ctx.ui.editor("Edit commit message", generatedMessage) : generatedMessage;
				if (!message?.trim()) {
					ctx.ui.notify("Commit cancelled.", "info");
					return;
				}

				let shouldPush = false;
				if (ctx.hasUI) {
					const changedFiles = status.split("\n").filter(Boolean).length;
					const confirmed = await ctx.ui.confirm(
						"Commit all changes?",
						`${changedFiles} changed file(s) will be committed.\n\n${message.trim()}`,
					);
					if (!confirmed) {
						ctx.ui.notify("Commit cancelled.", "info");
						return;
					}

					shouldPush = await ctx.ui.confirm("Push after commit?", "Run `git push` after the commit succeeds?");
				}

				ctx.ui.setStatus("commit", "committing");
				const validatedMessage = validateCommitMessage(message);
				await commitAllChanges(git, validatedMessage);

				const hash = await git.run(["rev-parse", "--short", "HEAD"]);
				pi.appendEntry<CommitMarker>(COMMIT_MARKER_TYPE, {
					hash,
					subject: validatedMessage.split("\n")[0] || validatedMessage,
					timestamp: Date.now(),
				});
				if (shouldPush) {
					ctx.ui.setStatus("commit", "pushing");
					await git.run(["push"], false, PUSH_TIMEOUT_MS);
					ctx.ui.notify(`Committed and pushed ${hash}: ${validatedMessage.split("\n")[0]}`, "info");
				} else {
					ctx.ui.notify(`Committed ${hash}: ${validatedMessage.split("\n")[0]}`, "info");
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Commit failed: ${message}`, "error");
			} finally {
				ctx.ui.setStatus("commit", undefined);
			}
		},
	});
}

interface CommitEvidence {
	recentSubjects: string;
	stagedDiff: string;
	unstagedDiff: string;
	untrackedFiles: string[];
	untrackedBlocks: string[];
}

interface CommitModel {
	model: Model<Api>;
	auth: { apiKey: string; headers?: Record<string, string> };
	reasoning: (typeof COMMIT_MODEL_TIERS)[number]["reasoning"] | undefined;
}

interface CommitModelFailure {
	model: CommitModel;
	error: Error;
	skippedProvider: boolean;
}

class CommitModelRequestError extends Error {}

class CommitModelOutputError extends Error {}

async function resolveCommitModels(ctx: ExtensionCommandContext): Promise<CommitModel[]> {
	const candidates: CommitModel[] = [];

	for (const tier of COMMIT_MODEL_TIERS) {
		const model = ctx.modelRegistry.find(tier.provider, tier.model);
		if (!model) continue;

		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (auth.ok && auth.apiKey)
			candidates.push({ model, auth: { ...auth, apiKey: auth.apiKey }, reasoning: tier.reasoning });
	}

	if (candidates.length > 0) return candidates;
	if (!ctx.model) throw new Error("No model selected and no commit model available.");

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
	if (!auth.ok) throw new Error(auth.error);
	if (!auth.apiKey) throw new Error(`No API key for ${ctx.model.provider}.`);
	return [{ model: ctx.model, auth: { ...auth, apiKey: auth.apiKey }, reasoning: undefined }];
}

async function collectCommitEvidence(git: GitRunner, signal: AbortSignal | undefined): Promise<CommitEvidence> {
	const [recentSubjects, stagedDiff, unstagedDiff, untrackedRaw] = await Promise.all([
		git.run(["log", "-12", "--pretty=format:%s"], true),
		git.run(["diff", "--cached", "--stat", "--patch", "--no-color", "--no-ext-diff"], true),
		git.run(["diff", "--stat", "--patch", "--no-color", "--no-ext-diff"], true),
		git.run(["ls-files", "--others", "--exclude-standard", "-z"]),
	]);

	const untrackedFiles = untrackedRaw.split("\0").filter(Boolean);
	const untrackedBlocks = await readUntrackedBlocks(git.cwd, untrackedFiles, signal);
	return { recentSubjects, stagedDiff, unstagedDiff, untrackedFiles, untrackedBlocks };
}

async function readUntrackedBlocks(
	repoRoot: string,
	untrackedFiles: string[],
	signal: AbortSignal | undefined,
): Promise<string[]> {
	const untrackedBlocks: string[] = [];
	let untrackedChars = 0;

	for (const file of untrackedFiles.slice(0, MAX_UNTRACKED_FILES)) {
		const block = await readUntrackedBlock(repoRoot, file, signal);
		if (untrackedChars + block.length > MAX_UNTRACKED_CONTENT_CHARS) {
			untrackedBlocks.push("[additional untracked file contents omitted]");
			break;
		}

		untrackedBlocks.push(block);
		untrackedChars += block.length;
	}

	if (untrackedFiles.length > MAX_UNTRACKED_FILES) {
		untrackedBlocks.push(`[${untrackedFiles.length - MAX_UNTRACKED_FILES} additional untracked files omitted]`);
	}

	return untrackedBlocks;
}

async function readUntrackedBlock(repoRoot: string, file: string, signal: AbortSignal | undefined): Promise<string> {
	try {
		const bytes = await readFile(join(repoRoot, file), { signal });
		return bytes.includes(0)
			? `--- ${file}\n[binary file content not embedded]`
			: `--- ${file}\n${bytes.toString("utf8").slice(0, MAX_UNTRACKED_FILE_CHARS)}`;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return `--- ${file}\n[unable to read untracked file: ${message}]`;
	}
}

function collectCommitIntent(entries: readonly SessionEntry[]): string[] {
	let messages: string[] = [];

	for (const entry of entries) {
		if (entry.type === "custom" && entry.customType === COMMIT_MARKER_TYPE) {
			messages = [];
			continue;
		}

		if (entry.type !== "message" || entry.message.role !== "user") continue;

		const text = extractUserMessageText(entry.message.content).trim();
		if (!text || /^\/commit(?:\s|$)/.test(text)) continue;
		messages.push(text);
	}

	return messages;
}

function collectActiveCommitProviderCooldowns(
	entries: readonly SessionEntry[],
	now: number,
): Map<string, CommitProviderCooldown> {
	const cooldowns = new Map<string, CommitProviderCooldown>();

	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== COMMIT_PROVIDER_COOLDOWN_TYPE) continue;

		const cooldown = parseCommitProviderCooldown(entry.data);
		if (!cooldown || cooldown.expiresAt <= now) continue;

		const existing = cooldowns.get(cooldown.provider);
		if (!existing || cooldown.expiresAt > existing.expiresAt) cooldowns.set(cooldown.provider, cooldown);
	}

	return cooldowns;
}

function parseCommitProviderCooldown(data: unknown): CommitProviderCooldown | undefined {
	if (!data || typeof data !== "object") return undefined;

	const record = data as Record<string, unknown>;
	if (typeof record.provider !== "string") return undefined;
	if (typeof record.failedAt !== "number") return undefined;
	if (typeof record.expiresAt !== "number") return undefined;
	if (typeof record.reason !== "string") return undefined;

	return {
		provider: record.provider,
		failedAt: record.failedAt,
		expiresAt: record.expiresAt,
		reason: record.reason,
	};
}

function applyCommitProviderCooldowns(
	commitModels: readonly CommitModel[],
	providerCooldowns: ReadonlyMap<string, CommitProviderCooldown>,
): readonly CommitModel[] {
	const availableModels = commitModels.filter((commitModel) => !providerCooldowns.has(commitModel.model.provider));
	return availableModels.length > 0 ? availableModels : commitModels;
}

function extractUserMessageText(content: string | Message["content"]): string {
	if (typeof content === "string") return content;

	return content
		.flatMap((part) => {
			if (part.type === "text") return [part.text];
			if (part.type === "image") return ["[image omitted]"];
			return [];
		})
		.join("\n");
}

function formatCommitIntent(messages: readonly string[]): string {
	if (messages.length === 0) return "(none)";
	return messages.map((message, index) => `[${index + 1}]\n${message}`).join("\n\n");
}

function buildCommitPrompt(status: string, evidence: CommitEvidence, intentMessages: readonly string[]): string {
	return [
		"Write a git commit message for all current repository changes.",
		"Always use this strict conventional commit format:",
		"<type>[optional scope][!]: <description>",
		"Allowed types: feat, fix, docs, refactor, test, chore, perf, ci, build, revert.",
		"Optional scope must be lowercase kebab-case, singular, and useful; omit it for broad or unrelated changes.",
		"Subject must be one concise line, imperative, no trailing period, max 100 characters.",
		"For non-breaking changes, return exactly one line and no body.",
		"For breaking changes, add ! to the header and include exactly one body paragraph starting with BREAKING CHANGE:.",
		"Do not include a body unless the header has !.",
		"Do not wrap in markdown or code fences.",
		"Use recent commit subjects only as secondary style guidance; these rules take priority.",
		"Use current user intent only as secondary context for why changes were made; git evidence is authoritative.",
		"",
		"Recent commit subjects:",
		evidence.recentSubjects || "(none)",
		"",
		"Current user intent since last successful commit:",
		formatCommitIntent(intentMessages),
		"",
		"Git status:",
		status,
		"",
		"Staged diff:",
		(evidence.stagedDiff || "(none)").slice(0, MAX_DIFF_CHARS),
		"",
		"Unstaged diff:",
		(evidence.unstagedDiff || "(none)").slice(0, MAX_DIFF_CHARS),
		"",
		"Untracked files:",
		evidence.untrackedFiles.length > 0 ? evidence.untrackedFiles.join("\n") : "(none)",
		"",
		"Untracked file contents:",
		evidence.untrackedBlocks.length > 0 ? evidence.untrackedBlocks.join("\n\n") : "(none)",
	].join("\n");
}

async function generateCommitMessageWithFallback(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	commitModels: readonly CommitModel[],
	prompt: string,
): Promise<string> {
	const failedProviders = new Set<string>();
	const failures: CommitModelFailure[] = [];

	for (const commitModel of commitModels) {
		if (failedProviders.has(commitModel.model.provider)) continue;

		ctx.ui.setStatus(
			"commit",
			`generating commit message with ${commitModel.model.provider}/${commitModel.model.id}`,
		);

		try {
			return await generateCommitMessage(ctx, commitModel, prompt);
		} catch (error) {
			if (ctx.signal?.aborted) throw new Error("Commit cancelled.");

			const normalizedError = normalizeError(error);
			const skippedProvider = shouldSkipProviderAfterFailure(normalizedError);
			failures.push({ model: commitModel, error: normalizedError, skippedProvider });
			if (skippedProvider) {
				recordCommitProviderCooldown(pi, commitModel.model.provider, normalizedError.message);
				failedProviders.add(commitModel.model.provider);
			}
		}
	}

	throw new Error(formatCommitModelFailures(failures));
}

async function generateCommitMessage(
	ctx: ExtensionCommandContext,
	commitModel: CommitModel,
	prompt: string,
): Promise<string> {
	const userMessage: Message = {
		role: "user",
		content: [{ type: "text", text: prompt }],
		timestamp: Date.now(),
	};
	const response = await complete(
		commitModel.model,
		{ messages: [userMessage] },
		{
			apiKey: commitModel.auth.apiKey,
			headers: commitModel.auth.headers,
			signal: ctx.signal,
			reasoning: commitModel.reasoning,
		},
	).catch((error: unknown) => {
		throw new CommitModelRequestError(error instanceof Error ? error.message : String(error));
	});

	if (response.stopReason === "error") {
		throw new CommitModelRequestError(response.errorMessage || "Commit message generation failed.");
	}
	if (response.stopReason === "aborted") throw new Error("Commit cancelled.");

	try {
		return validateCommitMessage(
			cleanCommitMessage(response.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")),
		);
	} catch (error) {
		throw new CommitModelOutputError(error instanceof Error ? error.message : String(error));
	}
}

function recordCommitProviderCooldown(pi: ExtensionAPI, provider: string, reason: string): void {
	const failedAt = Date.now();
	pi.appendEntry<CommitProviderCooldown>(COMMIT_PROVIDER_COOLDOWN_TYPE, {
		provider,
		failedAt,
		expiresAt: failedAt + COMMIT_PROVIDER_COOLDOWN_MS,
		reason: reason.slice(0, 300),
	});
}

function normalizeError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

function shouldSkipProviderAfterFailure(error: Error): boolean {
	if (!(error instanceof CommitModelRequestError)) return false;

	const message = error.message.toLowerCase();
	return /\b(?:401|402|403|429)\b|quota|credit|billing|payment|subscription|balance|insufficient|rate.?limit|too many requests|unauthori[sz]ed|forbidden|authentication|api key|permission|access denied|not entitled/.test(
		message,
	);
}

function formatCommitModelFailures(failures: readonly CommitModelFailure[]): string {
	if (failures.length === 0) return "No commit model available.";

	return [
		"Commit message generation failed for all available commit models:",
		...failures.map(({ model, error, skippedProvider }) => {
			const suffix = skippedProvider ? " (skipped remaining provider models)" : "";
			return `- ${model.model.provider}/${model.model.id}: ${error.message}${suffix}`;
		}),
	].join("\n");
}

function cleanCommitMessage(rawMessage: string): string {
	let message = rawMessage.trim();
	const fenced = message.match(/^```(?:gitcommit|text)?\s*\n([\s\S]*?)\n```$/i);
	if (fenced?.[1]) message = fenced[1].trim();
	message = message.replace(/^commit message:\s*/i, "").trim();
	if (!message) throw new Error("Model returned an empty commit message.");
	return message;
}

function validateCommitMessage(rawMessage: string): string {
	const message = rawMessage.trim();
	const [header = "", ...bodyLines] = message.split("\n");
	const headerMatch = header.match(/^([a-z]+)(?:\(([a-z0-9]+(?:-[a-z0-9]+)*)\))?(!)?: (.+)$/);
	if (!headerMatch) throw new Error("Commit message must use conventional commit format.");

	const [, type, , breakingMark, subject] = headerMatch;
	if (!type || !CONVENTIONAL_COMMIT_TYPES.has(type)) throw new Error(`Unsupported commit type: ${type || "missing"}.`);
	if (!subject || subject.length > 100) throw new Error("Commit subject must be 1-100 characters.");
	if (subject.endsWith(".")) throw new Error("Commit subject must not end with a period.");

	const body = bodyLines.join("\n").trim();
	if (!breakingMark && body) throw new Error("Commit body is only allowed for breaking changes.");
	if (breakingMark && !body.startsWith("BREAKING CHANGE: ")) {
		throw new Error("Breaking commits must include a body starting with BREAKING CHANGE:.");
	}
	if (breakingMark && body.split("\n\n").filter((paragraph) => paragraph.trim()).length !== 1) {
		throw new Error("Breaking commits must include exactly one BREAKING CHANGE paragraph.");
	}

	return body ? `${header}\n\n${body}` : header;
}

async function commitAllChanges(git: GitRunner, message: string): Promise<void> {
	const messageFile = join(tmpdir(), `pi-commit-${randomUUID()}.txt`);
	try {
		await writeFile(messageFile, `${message.trim()}\n`, "utf8");
		await git.run(["add", "-A"]);
		await git.run(["commit", "-F", messageFile], false, COMMIT_TIMEOUT_MS);
	} finally {
		await rm(messageFile, { force: true });
	}
}
