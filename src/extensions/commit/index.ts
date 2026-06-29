import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { emitAgentBlocked } from "../../shared/agent-blocked.ts";
import { createGitRunner, type GitRunner, loadRepoStatus } from "../../shared/git.ts";
import { errorText } from "../../shared/text.ts";
import { type CommitPlanState, generatePlan } from "./commit-plan.ts";
import {
	assertCommittableState,
	commitStaged,
	computeWorktreeSignature,
	type DirtyFile,
	loadChangeSet,
	stageFilesOnly,
} from "./git-change-set.ts";
import { reviewPlan } from "./review-ui.ts";

const COMMIT_MARKER_TYPE = "tau.commit";
const PUSH_TIMEOUT_MS = 120_000;

interface CommitMarker {
	hash: string;
	subject: string;
	timestamp: number;
}

export default function commitExtension(pi: ExtensionAPI): void {
	pi.registerCommand("commit", {
		description: "Generate semantic commit groups and commit selected repository changes",
		handler: async (_args, ctx) => {
			await ctx.waitForIdle();
			ctx.ui.setStatus("commit", "preparing commit plan");

			try {
				await runCommit(pi, ctx);
			} catch (error) {
				ctx.ui.notify(`Commit failed: ${errorText(error)}`, "error");
			} finally {
				ctx.ui.setStatus("commit", undefined);
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

	const evidence = await loadChangeSet(git, repo.root, ctx.sessionManager.getBranch(), COMMIT_MARKER_TYPE);
	assertCommittableState(evidence.files);
	let state: CommitPlanState = {
		files: evidence.files,
		worktreeSignature: await computeWorktreeSignature(git, repo.root, evidence.files),
		groups: await generatePlan(ctx, evidence),
	};

	if (ctx.hasUI) {
		emitAgentBlocked(pi, { body: "Waiting for commit plan review", source: "commit.review" });
		const reviewed = await reviewPlan(ctx, git, repo.root, evidence, state, state.groups[0]?.id, COMMIT_MARKER_TYPE);
		if (!reviewed) return;
		state = reviewed;
	}

	const completed = await executePlan(pi, ctx, git, repo.root, state);
	if (completed.length === 0) return;

	if (ctx.hasUI && (await ctx.ui.confirm("Push after commits?", "Run `git push` after all commits succeeded?"))) {
		ctx.ui.setStatus("commit", "pushing");
		await git.run(["push"], { cwd: repo.root, timeout: PUSH_TIMEOUT_MS });
		ctx.ui.notify(
			`Committed and pushed ${completed.length} commit(s): ${completed.map((item) => item.hash).join(", ")}`,
			"info",
		);
		return;
	}

	ctx.ui.notify(`Committed ${completed.length} commit(s): ${completed.map((item) => item.hash).join(", ")}`, "info");
}

async function executePlan(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	git: GitRunner,
	root: string,
	state: CommitPlanState,
): Promise<CommitMarker[]> {
	const groups = state.groups.filter((group) => group.files.length > 0);
	if (groups.length === 0) {
		ctx.ui.notify("No commit groups to execute.", "info");
		return [];
	}

	if ((await computeWorktreeSignature(git, root, state.files)) !== state.worktreeSignature) {
		throw new Error("Working tree changed during commit review. Regenerate the commit plan and try again.");
	}

	const filesByPath = new Map(state.files.map((file) => [file.path, file]));
	const completed: CommitMarker[] = [];
	try {
		for (const group of groups) {
			const subject = group.message.split("\n")[0] ?? group.message;
			ctx.ui.setStatus("commit", `committing ${subject}`);
			await stageFilesOnly(
				git,
				root,
				group.files.flatMap((path) => knownFile(filesByPath, path)),
			);
			const hash = await commitStaged(git, root, group.message);
			const marker = { hash, subject, timestamp: Date.now() };
			completed.push(marker);
			pi.appendEntry<CommitMarker>(COMMIT_MARKER_TYPE, marker);
		}
	} catch (error) {
		if (completed.length > 0) {
			ctx.ui.notify(
				`Partially committed ${completed.length}: ${completed.map((item) => item.hash).join(", ")}; then failed: ${errorText(error)}`,
				"warning",
			);
		}
		throw error;
	}
	return completed;
}

function knownFile(filesByPath: ReadonlyMap<string, DirtyFile>, path: string): DirtyFile[] {
	const file = filesByPath.get(path);
	return file ? [file] : [];
}
