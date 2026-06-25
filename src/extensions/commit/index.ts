import type { Message } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { emitAgentBlocked } from "../../shared/agent-blocked.ts";
import { createGitRunner, type GitRunner, loadRepoStatus } from "../../shared/git.ts";
import { errorText } from "../../shared/text.ts";
import { collectFileEvidence, commitStaged, computeWorktreeSignature, loadDirtyFiles, stageFilesOnly } from "./git.ts";
import {
	appendGroup,
	assignFilesToGroup,
	deleteGroup,
	generateInitialPlan,
	moveGroup,
	normalizePlan,
	regenerateGroupMessage,
	updateGroupMessage,
} from "./planner.ts";
import type {
	CommitEvidence,
	CommitFilePickerResult,
	CommitMarker,
	CommitPlanGroup,
	CommitPlanReviewAction,
	CommitPlanState,
	DirtyFile,
} from "./types.ts";
import { CommitFilePicker } from "./ui/commit-file-picker.ts";
import { CommitPlanReview } from "./ui/commit-plan-review.ts";

const PUSH_TIMEOUT_MS = 120_000;
const COMMIT_MARKER_TYPE = "tau.commit";

export default function commitExtension(pi: ExtensionAPI): void {
	pi.registerCommand("commit", {
		description: "Generate semantic commit groups and commit selected repository changes",
		handler: async (_args, ctx) => {
			await ctx.waitForIdle();
			ctx.ui.setStatus("commit", "preparing commit plan");

			try {
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

				let evidence = await loadEvidence(git, repo.root, ctx.sessionManager.getBranch());
				assertCommittableState(evidence.files);
				let state: CommitPlanState = {
					files: evidence.files,
					groups: await generateInitialPlan(ctx, evidence),
					worktreeSignature: await computeWorktreeSignature(git, repo.root, evidence.files),
				};
				let selectedGroupId: string | undefined = state.groups[0]?.id;

				if (ctx.hasUI) {
					emitAgentBlocked(pi, { body: "Waiting for commit plan review", source: "commit.review" });
					const result = await reviewPlan(ctx, git, repo.root, evidence, state, selectedGroupId);
					if (!result) return;
					state = result.state;
					evidence = result.evidence;
					selectedGroupId = result.selectedGroupId;
				}

				const completed = await executePlan(pi, ctx, git, repo.root, state, selectedGroupId);
				if (completed.length === 0) return;

				if (
					ctx.hasUI &&
					(await ctx.ui.confirm("Push after commits?", "Run `git push` after all commits succeeded?"))
				) {
					ctx.ui.setStatus("commit", "pushing");
					await git.run(["push"], { cwd: repo.root, timeout: PUSH_TIMEOUT_MS });
					ctx.ui.notify(
						`Committed and pushed ${completed.length} commit(s): ${completed.map((item) => item.hash).join(", ")}`,
						"info",
					);
				} else {
					ctx.ui.notify(
						`Committed ${completed.length} commit(s): ${completed.map((item) => item.hash).join(", ")}`,
						"info",
					);
				}
			} catch (error) {
				ctx.ui.notify(`Commit failed: ${errorText(error)}`, "error");
			} finally {
				ctx.ui.setStatus("commit", undefined);
			}
		},
	});
}

async function loadEvidence(git: GitRunner, root: string, entries: readonly SessionEntry[]): Promise<CommitEvidence> {
	const dirtyFiles = await collectFileEvidence(git, root, await loadDirtyFiles(git, root));
	const recentSubjects = await git.run(["log", "-12", "--pretty=format:%s"], { cwd: root, optional: true });
	return { recentSubjects, intent: collectIntent(entries), files: dirtyFiles };
}

async function reviewPlan(
	ctx: ExtensionCommandContext,
	git: GitRunner,
	root: string,
	evidence: CommitEvidence,
	initialState: CommitPlanState,
	initialSelectedGroupId: string | undefined,
): Promise<{ state: CommitPlanState; evidence: CommitEvidence; selectedGroupId: string | undefined } | undefined> {
	let state = initialState;
	let currentEvidence = evidence;
	let selectedGroupId = initialSelectedGroupId;

	while (true) {
		const action = await ctx.ui.custom<CommitPlanReviewAction>(
			(_tui, theme, _keybindings, done) => new CommitPlanReview(theme, state, selectedGroupId, done),
		);
		switch (action.kind) {
			case "cancel":
				ctx.ui.notify("Commit cancelled.", "info");
				return undefined;
			case "execute":
				return { state, evidence: currentEvidence, selectedGroupId };
			case "editMessage": {
				const group = state.groups.find((item) => item.id === action.groupId);
				if (!group) break;
				const edited = await ctx.ui.editor("Edit commit message", group.message);
				if (!edited?.trim()) break;
				try {
					state = { ...state, groups: updateGroupMessage(state.groups, action.groupId, edited) };
					selectedGroupId = action.groupId;
				} catch (error) {
					ctx.ui.notify(`Invalid commit message: ${errorText(error)}`, "error");
				}
				break;
			}
			case "assignFiles": {
				const group = state.groups.find((item) => item.id === action.groupId);
				if (!group) break;
				const result = await pickFiles(
					ctx,
					`Assign files to: ${group.message.split("\n")[0] ?? group.message}`,
					state,
					group.id,
					group.files,
					false,
				);
				if (result) {
					state = { ...state, groups: assignFilesToGroup(state.groups, group.id, result) };
					selectedGroupId = group.id;
				}
				break;
			}
			case "newGroup": {
				const result = await pickFiles(ctx, "New commit: select files", state, undefined, [], true);
				if (!result) break;
				if (result.length === 0) {
					ctx.ui.notify("No files selected.", "info");
					break;
				}
				// Editor first: an empty submit means "auto-generate". Avoids
				// burning a model call when the user cancels.
				const edited = await ctx.ui.editor("New commit message (empty = auto-generate)", "");
				if (edited === undefined) break;
				const message = edited.trim() || (await regenerateGroupMessage(ctx, currentEvidence, result));
				try {
					const groups = appendGroup(state.groups, message, result);
					state = { ...state, groups };
					selectedGroupId = groups.at(-1)?.id;
				} catch (error) {
					ctx.ui.notify(`Invalid commit message: ${errorText(error)}`, "error");
				}
				break;
			}
			case "deleteGroup":
				state = { ...state, groups: deleteGroup(state.groups, action.groupId) };
				selectedGroupId = state.groups[0]?.id;
				break;
			case "moveGroup":
				state = { ...state, groups: moveGroup(state.groups, action.groupId, action.direction) };
				selectedGroupId = action.groupId;
				break;
			case "regenerateMessage": {
				const group = state.groups.find((item) => item.id === action.groupId);
				if (!group) break;
				const note = await ctx.ui.editor("Regeneration note (optional)", "");
				if (note === undefined) break;
				const message = await regenerateGroupMessage(
					ctx,
					currentEvidence,
					group.files,
					state.groups,
					group.id,
					note,
				);
				state = { ...state, groups: updateGroupMessage(state.groups, action.groupId, message) };
				selectedGroupId = action.groupId;
				break;
			}
			case "regeneratePlan": {
				const note = await ctx.ui.editor("Regeneration note (optional)", "");
				if (note === undefined) break;
				const previousPlan = state.groups;
				currentEvidence = await loadEvidence(git, root, ctx.sessionManager.getBranch());
				assertCommittableState(currentEvidence.files);
				state = {
					files: currentEvidence.files,
					groups: await generateInitialPlan(ctx, currentEvidence, previousPlan, note),
					worktreeSignature: await computeWorktreeSignature(git, root, currentEvidence.files),
				};
				selectedGroupId = state.groups[0]?.id;
				break;
			}
		}
	}
}

async function pickFiles(
	ctx: ExtensionCommandContext,
	title: string,
	state: CommitPlanState,
	targetGroupId: string | undefined,
	initialFiles: readonly string[],
	preferUnassigned: boolean,
): Promise<string[] | undefined> {
	const result = await ctx.ui.custom<CommitFilePickerResult>(
		(tui, theme, _keybindings, done) =>
			new CommitFilePicker(
				tui,
				theme,
				title,
				state.files,
				state.groups,
				targetGroupId,
				initialFiles,
				preferUnassigned,
				done,
			),
	);
	return result.kind === "save" ? result.files : undefined;
}

async function executePlan(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	git: GitRunner,
	root: string,
	state: CommitPlanState,
	_selectedGroupId: string | undefined,
): Promise<CommitMarker[]> {
	const groups = normalizePlan(state.groups, state.files);
	if (groups.length === 0) {
		ctx.ui.notify("No commit groups to execute.", "info");
		return [];
	}

	const currentSignature = await computeWorktreeSignature(git, root, state.files);
	if (currentSignature !== state.worktreeSignature) {
		throw new Error("Working tree changed during commit review. Regenerate the commit plan and try again.");
	}

	const completed: CommitMarker[] = [];
	try {
		for (const group of groups) {
			ctx.ui.setStatus("commit", `committing ${group.message.split("\n")[0] ?? group.message}`);
			const files = filesForGroup(state.files, group);
			await stageFilesOnly(git, root, files);
			const hash = await commitStaged(git, root, group.message);
			const subject = group.message.split("\n")[0] ?? group.message;
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

function filesForGroup(files: readonly DirtyFile[], group: CommitPlanGroup): DirtyFile[] {
	const byPath = new Map(files.map((file) => [file.path, file]));
	return group.files.map((path) => byPath.get(path)).filter((file): file is DirtyFile => Boolean(file));
}

function assertCommittableState(files: readonly DirtyFile[]): void {
	const deletedStagedAdds = files.filter((file) => file.status === "AD").map((file) => file.path);
	if (deletedStagedAdds.length === 0) return;
	throw new Error(
		[
			"Staged additions were deleted from the working tree.",
			"Unstage or restore them before /commit:",
			...deletedStagedAdds.map((path) => `- ${path}`),
		].join("\n"),
	);
}

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
