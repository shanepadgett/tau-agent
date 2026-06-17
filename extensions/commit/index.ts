import { randomUUID } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { complete, type Message } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const GIT_TIMEOUT_MS = 10_000;
const COMMIT_TIMEOUT_MS = 120_000;
const MAX_DIFF_CHARS = 80_000;
const MAX_UNTRACKED_FILES = 12;
const MAX_UNTRACKED_FILE_CHARS = 6_000;
const MAX_UNTRACKED_CONTENT_CHARS = 30_000;

export default function commitExtension(pi: ExtensionAPI): void {
	pi.registerCommand("commit", {
		description: "Generate a commit message and commit all changes",
		handler: async (_args, ctx) => {
			await ctx.waitForIdle();
			ctx.ui.setStatus("commit", "preparing commit");

			let repoRoot = ctx.cwd;
			const runGit = async (args: string[], optional = false, timeout = GIT_TIMEOUT_MS): Promise<string> => {
				const result = await pi.exec("git", args, { cwd: repoRoot, signal: ctx.signal, timeout });
				if (result.code === 0) return result.stdout.trim();
				if (optional) return "";

				const details = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
				throw new Error(details || `git ${args.join(" ")} failed with exit code ${result.code}`);
			};

			try {
				// Resolve repo root first so every git command runs from top-level.
				const root = await runGit(["rev-parse", "--show-toplevel"], true);
				if (!root) {
					ctx.ui.notify("No git repository found.", "info");
					return;
				}
				repoRoot = root;

				const status = await runGit(["status", "--porcelain=v1", "--untracked-files=all"]);
				if (!status) {
					ctx.ui.notify("No uncommitted changes detected.", "info");
					return;
				}

				// Gather bounded evidence for message generation.
				const [recentSubjects, stagedDiff, unstagedDiff, untrackedRaw] = await Promise.all([
					runGit(["log", "-12", "--pretty=format:%s"], true),
					runGit(["diff", "--cached", "--stat", "--patch", "--no-color", "--no-ext-diff"], true),
					runGit(["diff", "--stat", "--patch", "--no-color", "--no-ext-diff"], true),
					runGit(["ls-files", "--others", "--exclude-standard", "-z"]),
				]);

				const untrackedFiles = untrackedRaw.split("\0").filter(Boolean);
				// Diffs omit untracked file bodies, so include small snippets for new files.
				const untrackedBlocks: string[] = [];
				let untrackedChars = 0;
				for (const file of untrackedFiles.slice(0, MAX_UNTRACKED_FILES)) {
					let block: string;
					try {
						const bytes = await readFile(join(repoRoot, file), { signal: ctx.signal });
						block = bytes.includes(0)
							? `--- ${file}\n[binary file content not embedded]`
							: `--- ${file}\n${bytes.toString("utf8").slice(0, MAX_UNTRACKED_FILE_CHARS)}`;
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						block = `--- ${file}\n[unable to read untracked file: ${message}]`;
					}

					if (untrackedChars + block.length > MAX_UNTRACKED_CONTENT_CHARS) {
						untrackedBlocks.push("[additional untracked file contents omitted]");
						break;
					}
					untrackedBlocks.push(block);
					untrackedChars += block.length;
				}
				if (untrackedFiles.length > MAX_UNTRACKED_FILES) {
					untrackedBlocks.push(
						`[${untrackedFiles.length - MAX_UNTRACKED_FILES} additional untracked files omitted]`,
					);
				}

				// Call the provider directly; do not add this prompt/response to active chat context.
				if (!ctx.model) throw new Error("No model selected.");
				const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
				if (!auth.ok) throw new Error(auth.error);
				if (!auth.apiKey) throw new Error(`No API key for ${ctx.model.provider}.`);

				ctx.ui.setStatus("commit", "generating commit message");
				const prompt = [
					"Write a git commit message for all current repository changes.",
					"Use recent commit subjects as style guidance.",
					"Prefer conventional commit style if it fits.",
					"Return only the commit message: subject line, optional blank line, optional body.",
					"Do not wrap in markdown or code fences.",
					"",
					"Recent commit subjects:",
					recentSubjects || "(none)",
					"",
					"Git status:",
					status,
					"",
					"Staged diff:",
					(stagedDiff || "(none)").slice(0, MAX_DIFF_CHARS),
					"",
					"Unstaged diff:",
					(unstagedDiff || "(none)").slice(0, MAX_DIFF_CHARS),
					"",
					"Untracked files:",
					untrackedFiles.length > 0 ? untrackedFiles.join("\n") : "(none)",
					"",
					"Untracked file contents:",
					untrackedBlocks.length > 0 ? untrackedBlocks.join("\n\n") : "(none)",
				].join("\n");

				const userMessage: Message = {
					role: "user",
					content: [{ type: "text", text: prompt }],
					timestamp: Date.now(),
				};
				const response = await complete(
					ctx.model,
					{ messages: [userMessage] },
					{ apiKey: auth.apiKey, headers: auth.headers, signal: ctx.signal },
				);
				if (response.stopReason === "error")
					throw new Error(response.errorMessage || "Commit message generation failed.");
				if (response.stopReason === "aborted") throw new Error("Commit cancelled.");

				let generatedMessage = response.content
					.flatMap((part) => (part.type === "text" ? [part.text] : []))
					.join("\n")
					.trim();
				const fenced = generatedMessage.match(/^```(?:gitcommit|text)?\s*\n([\s\S]*?)\n```$/i);
				if (fenced?.[1]) generatedMessage = fenced[1].trim();
				generatedMessage = generatedMessage.replace(/^commit message:\s*/i, "").trim();
				if (!generatedMessage) throw new Error("Model returned an empty commit message.");

				const message = ctx.hasUI ? await ctx.ui.editor("Edit commit message", generatedMessage) : generatedMessage;
				if (!message?.trim()) {
					ctx.ui.notify("Commit cancelled.", "info");
					return;
				}

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
				}

				ctx.ui.setStatus("commit", "committing");
				// Use -F with a temp file so multi-line messages are preserved exactly.
				const messageFile = join(tmpdir(), `pi-commit-${randomUUID()}.txt`);
				try {
					await writeFile(messageFile, `${message.trim()}\n`, "utf8");
					await runGit(["add", "-A"]);
					await runGit(["commit", "-F", messageFile], false, COMMIT_TIMEOUT_MS);
				} finally {
					await rm(messageFile, { force: true });
				}

				const hash = await runGit(["rev-parse", "--short", "HEAD"]);
				ctx.ui.notify(`Committed ${hash}: ${message.trim().split("\n")[0]}`, "info");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Commit failed: ${message}`, "error");
			} finally {
				ctx.ui.setStatus("commit", undefined);
			}
		},
	});
}
