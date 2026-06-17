import { randomUUID } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { complete, type Message } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { createGitRunner, type GitRunner } from "../../shared/git.ts";

const COMMIT_TIMEOUT_MS = 120_000;
const PUSH_TIMEOUT_MS = 120_000;
const MAX_DIFF_CHARS = 80_000;
const MAX_UNTRACKED_FILES = 12;
const MAX_UNTRACKED_FILE_CHARS = 6_000;
const MAX_UNTRACKED_CONTENT_CHARS = 30_000;

const COMMIT_MODEL_TIERS = [
	{ provider: "github-copilot", model: "gemini-3.5-flash", reasoning: "high" },
	{ provider: "github-copilot", model: "gpt-5.4-mini", reasoning: "high" },
	{ provider: "github-copilot", model: "claude-haiku-4.5", reasoning: "high" },
	{ provider: "openai-codex", model: "gpt-5.4-mini", reasoning: "high" },
	{ provider: "anthropic", model: "claude-haiku-4-5", reasoning: "high" },
] as const;

export default function commitExtension(pi: ExtensionAPI): void {
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
				const commitModel = await resolveCommitModel(ctx);

				ctx.ui.setStatus(
					"commit",
					`generating commit message with ${commitModel.model.provider}/${commitModel.model.id}`,
				);
				const generatedMessage = await generateCommitMessage(ctx, commitModel, buildCommitPrompt(status, evidence));

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
				await commitAllChanges(git, message);

				const hash = await git.run(["rev-parse", "--short", "HEAD"]);
				if (shouldPush) {
					ctx.ui.setStatus("commit", "pushing");
					await git.run(["push"], false, PUSH_TIMEOUT_MS);
					ctx.ui.notify(`Committed and pushed ${hash}: ${message.trim().split("\n")[0]}`, "info");
				} else {
					ctx.ui.notify(`Committed ${hash}: ${message.trim().split("\n")[0]}`, "info");
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

type CommitModel = Awaited<ReturnType<typeof resolveCommitModel>>;

async function resolveCommitModel(ctx: ExtensionCommandContext) {
	for (const tier of COMMIT_MODEL_TIERS) {
		const model = ctx.modelRegistry.find(tier.provider, tier.model);
		if (!model) continue;

		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (auth.ok && auth.apiKey) return { model, auth: { ...auth, apiKey: auth.apiKey }, reasoning: tier.reasoning };
	}

	if (!ctx.model) throw new Error("No model selected and no commit model available.");
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
	if (!auth.ok) throw new Error(auth.error);
	if (!auth.apiKey) throw new Error(`No API key for ${ctx.model.provider}.`);
	return { model: ctx.model, auth: { ...auth, apiKey: auth.apiKey }, reasoning: undefined };
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

function buildCommitPrompt(status: string, evidence: CommitEvidence): string {
	return [
		"Write a git commit message for all current repository changes.",
		"Use recent commit subjects as style guidance.",
		"Prefer conventional commit style if it fits.",
		"Return only the commit message: subject line, optional blank line, optional body.",
		"Do not wrap in markdown or code fences.",
		"",
		"Recent commit subjects:",
		evidence.recentSubjects || "(none)",
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
	);
	if (response.stopReason === "error") throw new Error(response.errorMessage || "Commit message generation failed.");
	if (response.stopReason === "aborted") throw new Error("Commit cancelled.");

	return cleanCommitMessage(response.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n"));
}

function cleanCommitMessage(rawMessage: string): string {
	let message = rawMessage.trim();
	const fenced = message.match(/^```(?:gitcommit|text)?\s*\n([\s\S]*?)\n```$/i);
	if (fenced?.[1]) message = fenced[1].trim();
	message = message.replace(/^commit message:\s*/i, "").trim();
	if (!message) throw new Error("Model returned an empty commit message.");
	return message;
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
