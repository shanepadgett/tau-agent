import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Api, complete, type Message, type Model, type ThinkingLevel } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { createGitRunner, type GitRunner } from "../../../../shared/git.ts";

const COMMIT_TIMEOUT_MS = 120_000;
const PUSH_TIMEOUT_MS = 120_000;
const MAX_DIFF_CHARS = 80_000;
const COMMIT_MARKER_TYPE = "tau.commit";

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

// Preferred cheap, fast models for off-context generation. Missing or
// unauthenticated entries are skipped silently; the active session model is
// always appended as the guaranteed fallback, so this list only needs to be
// good, not exhaustive or correct forever.
const PREFERRED_COMMIT_MODELS: ReadonlyArray<{ provider: string; model: string; reasoning: ThinkingLevel }> = [
	{ provider: "github-copilot", model: "gemini-3.5-flash", reasoning: "high" },
	{ provider: "openai-codex", model: "gpt-5.4-mini", reasoning: "high" },
	{ provider: "anthropic", model: "claude-haiku-4-5", reasoning: "high" },
];

interface CommitMarker {
	hash: string;
	subject: string;
	timestamp: number;
}

interface CommitCandidate {
	model: Model<Api>;
	apiKey: string;
	headers: Record<string, string> | undefined;
	reasoning: ThinkingLevel | undefined;
}

interface CommitEvidence {
	recentSubjects: string;
	diff: string;
	intent: string[];
}

export function registerCommit(pi: ExtensionAPI): void {
	pi.registerCommand("commit", {
		description: "Generate a commit message and commit all changes",
		handler: async (_args, ctx) => {
			await ctx.waitForIdle();
			ctx.ui.setStatus("commit", "preparing commit");

			try {
				const git = createGitRunner(pi, ctx);
				const root = await git.run(["rev-parse", "--show-toplevel"], { optional: true });
				if (!root) {
					ctx.ui.notify("No git repository found.", "info");
					return;
				}

				const status = await git.run(["status", "--porcelain=v1", "--untracked-files=all"], { cwd: root });
				if (!status) {
					ctx.ui.notify("No uncommitted changes detected.", "info");
					return;
				}
				const changedFiles = status.split("\n").filter(Boolean).length;

				// Stage everything up front so a single `git diff --cached` is the
				// complete, uniform picture: tracked edits and new files alike, with
				// binary handling free. This command always commits all changes, so
				// staging early matches its contract.
				await git.run(["add", "-A"], { cwd: root });

				const evidence = await collectEvidence(git, root, ctx.sessionManager.getBranch());
				const candidates = await resolveCandidates(ctx);
				const generated = await generateMessage(ctx, candidates, buildPrompt(evidence));

				const edited = ctx.hasUI ? await ctx.ui.editor("Edit commit message", generated) : generated;
				if (!edited?.trim()) {
					ctx.ui.notify("Commit cancelled.", "info");
					return;
				}
				const message = validateMessage(edited);
				const subject = message.split("\n")[0] ?? message;

				let shouldPush = false;
				if (ctx.hasUI) {
					const confirmed = await ctx.ui.confirm(
						"Commit all changes?",
						`${changedFiles} changed file(s) will be committed.\n\n${message}`,
					);
					if (!confirmed) {
						ctx.ui.notify("Commit cancelled.", "info");
						return;
					}
					shouldPush = await ctx.ui.confirm("Push after commit?", "Run `git push` after the commit succeeds?");
				}

				ctx.ui.setStatus("commit", "committing");
				await commitStaged(git, root, message);

				const hash = await git.run(["rev-parse", "--short", "HEAD"], { cwd: root });
				pi.appendEntry<CommitMarker>(COMMIT_MARKER_TYPE, { hash, subject, timestamp: Date.now() });

				if (shouldPush) {
					ctx.ui.setStatus("commit", "pushing");
					await git.run(["push"], { cwd: root, timeout: PUSH_TIMEOUT_MS });
					ctx.ui.notify(`Committed and pushed ${hash}: ${subject}`, "info");
				} else {
					ctx.ui.notify(`Committed ${hash}: ${subject}`, "info");
				}
			} catch (error) {
				ctx.ui.notify(`Commit failed: ${errorText(error)}`, "error");
			} finally {
				ctx.ui.setStatus("commit", undefined);
			}
		},
	});
}

async function collectEvidence(git: GitRunner, cwd: string, entries: readonly SessionEntry[]): Promise<CommitEvidence> {
	const [recentSubjects, diff] = await Promise.all([
		git.run(["log", "-12", "--pretty=format:%s"], { cwd, optional: true }),
		git.run(["diff", "--cached", "--stat", "--patch", "--no-color", "--no-ext-diff"], { cwd, optional: true }),
	]);
	return { recentSubjects, diff, intent: collectIntent(entries) };
}

// User intent since the last successful commit: text user messages on the
// active branch, reset whenever a commit marker is crossed.
function collectIntent(entries: readonly SessionEntry[]): string[] {
	let intent: string[] = [];

	for (const entry of entries) {
		if (entry.type === "custom" && entry.customType === COMMIT_MARKER_TYPE) {
			intent = [];
			continue;
		}
		if (entry.type !== "message" || entry.message.role !== "user") continue;

		const text = extractUserText(entry.message.content).trim();
		if (!text || /^\/commit(?:\s|$)/.test(text)) continue;
		intent.push(text);
	}

	return intent;
}

function extractUserText(content: string | Message["content"]): string {
	if (typeof content === "string") return content;

	return content
		.flatMap((part) => {
			if (part.type === "text") return [part.text];
			if (part.type === "image") return ["[image omitted]"];
			return [];
		})
		.join("\n");
}

function buildPrompt(evidence: CommitEvidence): string {
	const intent =
		evidence.intent.length > 0
			? evidence.intent.map((message, index) => `[${index + 1}]\n${message}`).join("\n\n")
			: "(none)";

	return [
		"Write a git commit message for all staged repository changes.",
		"Use this strict conventional commit format:",
		"<type>[optional scope][!]: <description>",
		"Allowed types: feat, fix, docs, refactor, test, chore, perf, ci, build, revert.",
		"Optional scope must be lowercase kebab-case, singular, and useful; omit it for broad or unrelated changes.",
		"Subject must be one concise imperative line, no trailing period, max 100 characters.",
		"For non-breaking changes, return exactly one line and no body.",
		"For breaking changes, add ! to the header and include exactly one body paragraph starting with BREAKING CHANGE:.",
		"Do not include a body unless the header has !.",
		"Do not wrap the message in markdown or code fences.",
		"Recent commit subjects are secondary style guidance; these rules take priority.",
		"User intent is secondary context for why; the diff is authoritative for what changed.",
		"",
		"Recent commit subjects:",
		evidence.recentSubjects || "(none)",
		"",
		"User intent since last commit:",
		intent,
		"",
		"Staged changes:",
		(evidence.diff || "(none)").slice(0, MAX_DIFF_CHARS),
	].join("\n");
}

async function resolveCandidates(ctx: ExtensionCommandContext): Promise<CommitCandidate[]> {
	const candidates: CommitCandidate[] = [];
	const seen = new Set<string>();

	const add = async (model: Model<Api>, reasoning: ThinkingLevel | undefined): Promise<void> => {
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

	if (candidates.length === 0) throw new Error("No authenticated model available for commit message generation.");
	return candidates;
}

async function generateMessage(
	ctx: ExtensionCommandContext,
	candidates: readonly CommitCandidate[],
	prompt: string,
): Promise<string> {
	const failures: string[] = [];

	for (const candidate of candidates) {
		const label = `${candidate.model.provider}/${candidate.model.id}`;
		ctx.ui.setStatus("commit", `generating commit message (${label})`);

		try {
			return await requestMessage(ctx, candidate, prompt);
		} catch (error) {
			if (ctx.signal?.aborted) throw new Error("Commit cancelled.");
			failures.push(`- ${label}: ${errorText(error)}`);
		}
	}

	throw new Error(["Commit message generation failed for all models:", ...failures].join("\n"));
}

async function requestMessage(
	ctx: ExtensionCommandContext,
	candidate: CommitCandidate,
	prompt: string,
): Promise<string> {
	const userMessage: Message = { role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() };
	const response = await complete(
		candidate.model,
		{ messages: [userMessage] },
		{ apiKey: candidate.apiKey, headers: candidate.headers, signal: ctx.signal, reasoning: candidate.reasoning },
	);

	if (response.stopReason === "aborted") throw new Error("Commit cancelled.");
	if (response.stopReason === "error") throw new Error(response.errorMessage || "model returned an error");

	const text = response.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
	return validateMessage(cleanMessage(text));
}

function cleanMessage(rawMessage: string): string {
	let message = rawMessage.trim();
	const fenced = message.match(/^```(?:gitcommit|text)?\s*\n([\s\S]*?)\n```$/i);
	if (fenced?.[1]) message = fenced[1].trim();
	return message.replace(/^commit message:\s*/i, "").trim();
}

function validateMessage(rawMessage: string): string {
	const message = rawMessage.trim();
	if (!message) throw new Error("Commit message is empty.");

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

async function commitStaged(git: GitRunner, cwd: string, message: string): Promise<void> {
	const messageFile = join(tmpdir(), `pi-commit-${randomUUID()}.txt`);
	try {
		await writeFile(messageFile, `${message}\n`, "utf8");
		await git.run(["commit", "-F", messageFile], { cwd, timeout: COMMIT_TIMEOUT_MS });
	} finally {
		await rm(messageFile, { force: true });
	}
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
