import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { createGitRunner, loadRepoStatus } from "../../shared/git.ts";
import { createInjectedContext } from "../../shared/injected-context.ts";
import { errorText } from "../../shared/text.ts";
import {
	formatReviewMarkdown,
	isReviewRecord,
	isReviewMode,
	REVIEW_ENTRY_TYPE,
	type ReviewMode,
	type ReviewRecord,
} from "./model.ts";
import { ReviewProgressPanel, ReviewResultPanel, type ReviewResultAction } from "./panel.ts";
import { runReview } from "./session.ts";

export default function reviewExtension(pi: ExtensionAPI): void {
	pi.registerCommand("review", {
		description: "Run or show an isolated simplify, architecture, or correctness review",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui" || !ctx.isProjectTrusted()) {
				ctx.ui.notify("/review requires a trusted TUI project", "warning");
				return;
			}
			await ctx.waitForIdle();
			const requested = args.trim().toLowerCase();
			if (requested === "show") {
				const latest = latestReview(ctx.sessionManager.getBranch());
				if (!latest) {
					ctx.ui.notify("No review exists on this session branch", "warning");
					return;
				}
				await showReview(pi, ctx, latest);
				return;
			}

			let mode: ReviewMode | undefined;
			if (requested) {
				if (!isReviewMode(requested)) {
					ctx.ui.notify("Usage: /review [simplify|architecture|correctness|show]", "warning");
					return;
				}
				mode = requested;
			} else {
				const selected = await ctx.ui.select("Review mode", ["Simplify", "Architecture", "Correctness"]);
				if (!selected) return;
				const normalized = selected.toLowerCase();
				if (!isReviewMode(normalized)) return;
				mode = normalized;
			}

			const status = await loadRepoStatus(createGitRunner(pi, ctx));
			if (!status) {
				ctx.ui.notify("/review requires a Git repository", "warning");
				return;
			}
			if (status.fileCount === 0) {
				ctx.ui.notify("Nothing to review: working tree is clean", "info");
				return;
			}

			const controller = new AbortController();
			const signal = ctx.signal ? AbortSignal.any([controller.signal, ctx.signal]) : controller.signal;
			let failure: string | undefined;
			const output = await ctx.ui.custom<ReviewRecord | undefined>((tui, theme, keys, done) => {
				const panel = new ReviewProgressPanel(tui, theme, mode, keys, () => controller.abort());
				void runReview({
					ctx,
					root: status.root,
					mode,
					parentThinkingLevel: pi.getThinkingLevel(),
					signal,
					onProgress: (line) => panel.update(line),
				})
					.then((result) => done({ ...result, mode, root: status.root, createdAt: new Date().toISOString() }))
					.catch((error: unknown) => {
						failure = errorText(error);
						done(undefined);
					});
				return panel;
			});
			if (!output) {
				ctx.ui.notify(
					signal.aborted ? "Review cancelled" : `Review failed: ${failure ?? "unknown error"}`,
					signal.aborted ? "info" : "error",
				);
				return;
			}
			pi.appendEntry(REVIEW_ENTRY_TYPE, output);
			await showReview(pi, ctx, output);
		},
	});
}

function latestReview(entries: readonly SessionEntry[]): ReviewRecord | undefined {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (entry?.type !== "custom" || entry.customType !== REVIEW_ENTRY_TYPE) continue;
		if (isReviewRecord(entry.data)) return entry.data;
	}
	return undefined;
}

async function showReview(pi: ExtensionAPI, ctx: ExtensionContext, review: ReviewRecord): Promise<void> {
	const action = await ctx.ui.custom<ReviewResultAction>(
		(tui, theme, keys, done) => new ReviewResultPanel(tui, theme, keys, review, done),
		{
			overlay: true,
			overlayOptions: { anchor: "top-center", width: "80%", minWidth: 68, maxHeight: "90%", margin: 1 },
		},
	);
	if (action === "send") {
		try {
			await pi.sendMessage(
				createInjectedContext(formatReviewMarkdown(review), { source: "review", title: `${review.mode} review` }),
				{ triggerTurn: false, deliverAs: "nextTurn" },
			);
			ctx.ui.notify("Review queued for agent's next turn", "info");
		} catch (error) {
			ctx.ui.notify(`Failed to send review: ${errorText(error)}`, "error");
		}
	} else if (action === "export") {
		try {
			const directory = join(review.root, ".pi", "tau", "reviews");
			await mkdir(directory, { recursive: true });
			const timestamp = review.createdAt.replace(/[^0-9A-Za-z-]/g, "-");
			const path = join(directory, `${timestamp}-${review.mode}.md`);
			await writeFile(path, formatReviewMarkdown(review), { encoding: "utf8", mode: 0o600 });
			ctx.ui.notify(`Review exported to ${path}`, "info");
		} catch (error) {
			ctx.ui.notify(`Failed to export review: ${errorText(error)}`, "error");
		}
	}
}
