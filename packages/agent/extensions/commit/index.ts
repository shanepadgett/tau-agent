import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { createGitRunner, loadRepoStatus } from "../../shared/git.ts";
import { errorText } from "../../shared/text.ts";
import { type CommitPlanState, generatePlan } from "./commit-plan.ts";
import { assertCommittableState, computeWorktreeSignature, loadChangeSet } from "./git-change-set.ts";
import { executeCommitPlan, PartialCommitError, runCommitFlow } from "./review-ui.ts";

const COMMIT_MARKER_TYPE = "tau.commit";

export default function commitExtension(pi: ExtensionAPI): void {
	pi.registerCommand("commit", {
		description: "Generate semantic commit groups and commit selected repository changes",
		handler: async (_args, ctx) => {
			await ctx.waitForIdle();
			try {
				await runCommit(pi, ctx);
			} catch (error) {
				ctx.ui.notify(`Commit failed: ${errorText(error)}`, "error");
			}
		},
	});
}

async function runCommit(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	const git = createGitRunner(pi, ctx);
	const repo = await loadRepoStatus(git);
	if (!repo) {
		ctx.ui.notify("No git repository found.", "info");
		return;
	}
	if (repo.fileCount === 0) {
		ctx.ui.notify("No uncommitted changes detected.", "info");
		return;
	}
	if (ctx.hasUI && ctx.mode !== "tui") {
		ctx.ui.notify("Commit review UI requires TUI mode.", "error");
		return;
	}

	if (ctx.hasUI) {
		await runCommitFlow(pi, ctx, git, repo.root, COMMIT_MARKER_TYPE);
		return;
	}

	const evidence = await loadChangeSet(git, repo.root, ctx.sessionManager.getBranch(), COMMIT_MARKER_TYPE);
	assertCommittableState(evidence.files);
	const state: CommitPlanState = {
		files: evidence.files,
		worktreeSignature: await computeWorktreeSignature(git, repo.root, evidence.files),
		groups: await generatePlan(ctx, evidence),
	};
	try {
		const completed = await executeCommitPlan(pi, git, repo.root, state, COMMIT_MARKER_TYPE);
		if (completed.length === 0) {
			ctx.ui.notify("No commit groups to execute.", "info");
			return;
		}
		ctx.ui.notify(
			`Committed ${completed.length} commit(s): ${completed.map((item) => item.hash).join(", ")}`,
			"info",
		);
	} catch (error) {
		if (error instanceof PartialCommitError) {
			ctx.ui.notify(
				`Partially committed ${error.completed.length}: ${error.completed.map((item) => item.hash).join(", ")}; then failed: ${error.message}`,
				"warning",
			);
		}
		throw error;
	}
}
