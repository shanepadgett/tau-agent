import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createGitRunner, loadRepoStatus } from "../../shared/git.ts";
import { resolveEffortProviders } from "../../shared/model-effort.ts";
import { errorText } from "../../shared/text.ts";
import { formatReviewMarkdown } from "./model.ts";
import { runReview } from "./session.ts";

export default function reviewExtension(pi: ExtensionAPI): void {
	pi.registerCommand("review", {
		description: "Write an isolated review of current Git changes to Markdown",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui" || !ctx.isProjectTrusted()) {
				ctx.ui.notify("/review requires a trusted TUI project", "warning");
				return;
			}
			await ctx.waitForIdle();
			const direction = args.trim();
			const status = await loadRepoStatus(createGitRunner(pi, ctx));
			if (!status) {
				ctx.ui.notify("/review requires a Git repository", "warning");
				return;
			}
			if (status.fileCount === 0) {
				ctx.ui.notify("Nothing to review: working tree is clean", "info");
				return;
			}
			const providers = resolveEffortProviders(ctx, "deep");
			let preferred: ReviewModelChoice | undefined;
			if (providers.length > 0) {
				const labels = providers.map((provider) => `${provider.label} · ${provider.candidates[0]?.model.id ?? ""}`);
				const selected = await ctx.ui.select("Review provider", labels);
				if (!selected) return;
				const provider = providers[labels.indexOf(selected)];
				const candidate = provider?.candidates[0];
				if (provider && candidate) {
					preferred = { model: `${provider.provider}/${candidate.model.id}`, thinkingLevel: candidate.reasoning };
				}
			} else {
				ctx.ui.notify("No logged-in review provider. Using current model.", "warning");
			}
			const signal = ctx.signal ?? new AbortController().signal;
			ctx.ui.setStatus("review", "running review");
			try {
				const output = await runReview({
					ctx,
					root: status.root,
					direction,
					preferredModel: preferred?.model,
					preferredThinkingLevel: preferred?.thinkingLevel,
					parentThinkingLevel: pi.getThinkingLevel(),
					signal,
				});
				const createdAt = new Date().toISOString();
				const directory = join(status.root, ".pi", "tau", "reviews");
				const timestamp = createdAt.replace(/[^0-9A-Za-z-]/g, "-");
				const path = join(directory, `${timestamp}-review.md`);
				await mkdir(directory, { recursive: true });
				await writeFile(path, formatReviewMarkdown({ ...output, direction, createdAt }), {
					encoding: "utf8",
					mode: 0o600,
				});
				ctx.ui.notify(`Review written to ${path}`, "info");
			} catch (error) {
				ctx.ui.notify(
					signal.aborted ? "Review cancelled" : `Review failed: ${errorText(error)}`,
					signal.aborted ? "info" : "error",
				);
			} finally {
				ctx.ui.setStatus("review", undefined);
			}
		},
	});
}

interface ReviewModelChoice {
	model: string;
	thinkingLevel: NonNullable<ExtensionContext["thinkingLevel"]>;
}
