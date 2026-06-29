import { createHash, randomUUID } from "node:crypto";
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Message, type Tool, Type } from "@earendil-works/pi-ai";
import {
	type ExtensionAPI,
	type ExtensionCommandContext,
	type KeybindingsManager,
	keyHint,
	rawKeyHint,
	type SessionEntry,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type Focusable,
	Input,
	Key,
	matchesKey,
	type TUI,
	truncateToWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { emitAgentBlocked } from "../../shared/agent-blocked.ts";
import { createGitRunner, type GitRunner, loadRepoStatus } from "../../shared/git.ts";
import {
	generateToolValidated,
	generateValidated,
	resolveCandidatesForPrompt,
} from "../../shared/model-fallback/index.ts";
import { errorText, truncAt } from "../../shared/text.ts";

const COMMIT_MARKER_TYPE = "tau.commit";
const COMMIT_TIMEOUT_MS = 120_000;
const PUSH_TIMEOUT_MS = 120_000;
const EVIDENCE_CONCURRENCY = 4;
const MAX_FILE_EVIDENCE_CHARS = 4_000;
const MAX_PLAN_EVIDENCE_CHARS = 48_000;
const MAX_INTENT_CHARS = 8_000;
const MAX_UNTRACKED_PREVIEW_BYTES = 12_000;
const MAX_VISIBLE_PLAN_LINES = 18;

const CONVENTIONAL_COMMIT_TYPES = "feat, fix, docs, refactor, test, chore, perf, ci, build, revert";
const COMMIT_PLAN_TOOL = {
	name: "create_commit_plan",
	description: "Submit the commit plan for the dirty repository files.",
	parameters: Type.Object({
		commits: Type.Array(
			Type.Object({
				message: Type.String({ description: "Git commit message." }),
				allFiles: Type.Boolean({ description: "True only for a single commit that includes every dirty file." }),
				files: Type.Array(Type.Integer({ description: "Numeric dirty file ID. Empty when allFiles is true." })),
			}),
		),
	}),
} satisfies Tool;

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

// Command workflow

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

	const evidence = await loadChangeSet(git, repo.root, ctx.sessionManager.getBranch());
	assertCommittableState(evidence.files);
	let state: CommitPlanState = {
		files: evidence.files,
		worktreeSignature: await computeWorktreeSignature(git, repo.root, evidence.files),
		groups: await generatePlan(ctx, evidence),
	};
	const selectedGroupId: string | undefined = state.groups[0]?.id;

	if (ctx.hasUI) {
		emitAgentBlocked(pi, { body: "Waiting for commit plan review", source: "commit.review" });
		const reviewed = await reviewPlan(ctx, git, repo.root, evidence, state, selectedGroupId);
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

async function reviewPlan(
	ctx: ExtensionCommandContext,
	git: GitRunner,
	root: string,
	evidence: CommitEvidence,
	initialState: CommitPlanState,
	initialSelectedGroupId: string | undefined,
): Promise<CommitPlanState | undefined> {
	let state = initialState;
	let currentEvidence = evidence;
	let selectedGroupId = initialSelectedGroupId;

	while (true) {
		const action = await ctx.ui.custom<CommitPlanReviewAction>(
			(tui, theme, keybindings, done) => new CommitPlanReview(tui, theme, keybindings, state, selectedGroupId, done),
		);
		switch (action.kind) {
			case "cancel":
				ctx.ui.notify("Commit cancelled.", "info");
				return undefined;
			case "execute":
				return state;
			case "editMessage": {
				const group = state.groups.find((item) => item.id === action.groupId);
				if (!group) break;
				const edited = await ctx.ui.editor("Edit commit message", group.message);
				if (!edited?.trim()) break;
				try {
					const message = requireCommitMessage(edited);
					state = {
						...state,
						groups: state.groups.map((item) => (item.id === action.groupId ? { ...item, message } : item)),
					};
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
				if (!result) break;
				const selected = new Set(result);
				state = {
					...state,
					groups: state.groups.map((item) => {
						if (item.id === group.id) return { ...item, files: [...selected] };
						return { ...item, files: item.files.filter((file) => !selected.has(file)) };
					}),
				};
				selectedGroupId = group.id;
				break;
			}
			case "newGroup": {
				const result = await pickFiles(ctx, "New commit: select files", state, undefined, [], true);
				if (!result) break;
				if (result.length === 0) {
					ctx.ui.notify("No files selected.", "info");
					break;
				}

				// Editor first: an empty submit means "auto-generate". Avoids a
				// model call when the user cancels.
				const edited = await ctx.ui.editor("New commit message (empty = auto-generate)", "");
				if (edited === undefined) break;
				let message: string;
				if (edited.trim()) {
					try {
						message = requireCommitMessage(edited);
					} catch (error) {
						ctx.ui.notify(`Invalid commit message: ${errorText(error)}`, "error");
						break;
					}
				} else {
					message = await regenerateMessage(ctx, currentEvidence, result);
				}
				const selected = new Set(result);
				const groups = [
					...state.groups.map((group) => ({
						...group,
						files: group.files.filter((file) => !selected.has(file)),
					})),
					{ id: randomUUID(), message, files: result },
				];
				state = { ...state, groups };
				selectedGroupId = groups.at(-1)?.id;
				break;
			}
			case "deleteGroup":
				state = { ...state, groups: state.groups.filter((group) => group.id !== action.groupId) };
				selectedGroupId = state.groups[0]?.id;
				break;
			case "moveGroup": {
				const groups = [...state.groups];
				const index = groups.findIndex((group) => group.id === action.groupId);
				const target = index + action.direction;
				const moving = groups[index];
				if (!moving || target < 0 || target >= groups.length) break;
				groups.splice(index, 1);
				groups.splice(target, 0, moving);
				state = { ...state, groups };
				selectedGroupId = action.groupId;
				break;
			}
			case "regenerateMessage": {
				const group = state.groups.find((item) => item.id === action.groupId);
				if (!group) break;
				const note = await ctx.ui.editor("Regeneration note (optional)", "");
				if (note === undefined) break;
				const message = await regenerateMessage(ctx, currentEvidence, group.files, state.groups, group.id, note);
				state = {
					...state,
					groups: state.groups.map((item) => (item.id === action.groupId ? { ...item, message } : item)),
				};
				selectedGroupId = action.groupId;
				break;
			}
			case "regeneratePlan": {
				const note = await ctx.ui.editor("Regeneration note (optional)", "");
				if (note === undefined) break;
				const previousPlan = state.groups;
				currentEvidence = await loadChangeSet(git, root, ctx.sessionManager.getBranch());
				assertCommittableState(currentEvidence.files);
				state = {
					files: currentEvidence.files,
					worktreeSignature: await computeWorktreeSignature(git, root, currentEvidence.files),
					groups: await generatePlan(ctx, currentEvidence, previousPlan, note),
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
		(tui, theme, keybindings, done) =>
			new CommitFilePicker(
				tui,
				theme,
				keybindings,
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
): Promise<CommitMarker[]> {
	const groups = state.groups.filter((group) => group.files.length > 0);
	if (groups.length === 0) {
		ctx.ui.notify("No commit groups to execute.", "info");
		return [];
	}

	const currentSignature = await computeWorktreeSignature(git, root, state.files);
	if (currentSignature !== state.worktreeSignature) {
		throw new Error("Working tree changed during commit review. Regenerate the commit plan and try again.");
	}

	const filesByPath = new Map(state.files.map((file) => [file.path, file]));
	const completed: CommitMarker[] = [];
	try {
		for (const group of groups) {
			ctx.ui.setStatus("commit", `committing ${group.message.split("\n")[0] ?? group.message}`);
			const files = group.files.flatMap((path) => {
				const file = filesByPath.get(path);
				return file ? [file] : [];
			});
			await stageFilesOnly(git, root, files);
			const hash = await commitStaged(git, root, group.message);
			const marker = { hash, subject: group.message.split("\n")[0] ?? group.message, timestamp: Date.now() };
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

// Git snapshot, evidence, and execution

interface CommitEvidence {
	recentSubjects: string;
	intent: readonly string[];
	files: readonly DirtyFile[];
}

interface DirtyFile {
	id: number;
	path: string;
	status: string;
	kind: "modified" | "added" | "deleted" | "renamed" | "untracked";
	untracked: boolean;
	evidence: string;
	renamedFrom?: string;
}

interface ParsedDirtyFile {
	path: string;
	status: string;
	untracked: boolean;
	renamedFrom?: string;
}

async function loadChangeSet(git: GitRunner, root: string, entries: readonly SessionEntry[]): Promise<CommitEvidence> {
	const [raw, head, recentSubjects] = await Promise.all([
		git.run(["status", "--porcelain=v2", "-z", "--untracked-files=all"], { cwd: root }),
		git.run(["rev-parse", "--verify", "HEAD"], { cwd: root, optional: true }),
		git.run(["log", "-12", "--pretty=format:%s"], { cwd: root, optional: true }),
	]);
	const files = parsePorcelainV2Z(raw);
	const withEvidence = await collectFileEvidence(git, root, files, Boolean(head));
	return { recentSubjects, intent: collectIntent(entries), files: withEvidence };
}

async function collectFileEvidence(
	git: GitRunner,
	root: string,
	files: readonly DirtyFile[],
	hasHead: boolean,
): Promise<DirtyFile[]> {
	const withEvidence: DirtyFile[] = [];
	for (let index = 0; index < files.length; index += EVIDENCE_CONCURRENCY) {
		const batch = files.slice(index, index + EVIDENCE_CONCURRENCY);
		withEvidence.push(
			...(await Promise.all(
				batch.map(async (file) => ({ ...file, evidence: await loadEvidenceForFile(git, root, file, hasHead) })),
			)),
		);
	}
	return withEvidence;
}

async function computeWorktreeSignature(git: GitRunner, root: string, files: readonly DirtyFile[]): Promise<string> {
	const hash = createHash("sha256");
	const [status, stagedDiff, unstagedDiff] = await Promise.all([
		git.run(["status", "--porcelain=v2", "-z", "--untracked-files=all"], { cwd: root }),
		git.run(["diff", "--cached", "--no-color", "--no-ext-diff"], { cwd: root, optional: true }),
		git.run(["diff", "--no-color", "--no-ext-diff"], { cwd: root, optional: true }),
	]);
	hash.update(status);
	hash.update("\0staged\0");
	hash.update(stagedDiff);
	hash.update("\0unstaged\0");
	hash.update(unstagedDiff);

	for (const file of files.filter((item) => item.untracked)) {
		const fullPath = join(root, file.path);
		try {
			const info = await stat(fullPath);
			hash.update(`\0${file.path}:${info.size}:${info.mtimeMs}`);
			if (info.isFile() && info.size <= MAX_UNTRACKED_PREVIEW_BYTES) hash.update(await readFile(fullPath));
		} catch {
			hash.update(`\0${file.path}:missing`);
		}
	}

	return hash.digest("hex");
}

async function stageFilesOnly(git: GitRunner, root: string, files: readonly DirtyFile[]): Promise<void> {
	await git.run(["reset", "--mixed", "--quiet"], { cwd: root });
	const paths = files.flatMap((file) => (file.renamedFrom ? [file.renamedFrom, file.path] : [file.path]));
	if (paths.length === 0) return;
	await git.run(["add", "--", ...paths], { cwd: root });
}

async function commitStaged(git: GitRunner, root: string, message: string): Promise<string> {
	const messageFile = join(tmpdir(), `pi-commit-${randomUUID()}.txt`);
	try {
		await writeFile(messageFile, `${message}\n`, "utf8");
		await git.run(["commit", "-F", messageFile], { cwd: root, timeout: COMMIT_TIMEOUT_MS });
		return await git.run(["rev-parse", "--short", "HEAD"], { cwd: root });
	} finally {
		await rm(messageFile, { force: true });
	}
}

function parsePorcelainV2Z(raw: string): DirtyFile[] {
	if (!raw) return [];
	const parts = raw.split("\0").filter(Boolean);
	const parsed: ParsedDirtyFile[] = [];

	for (let index = 0; index < parts.length; index++) {
		const entry = parts[index];
		if (!entry) continue;
		const kind = entry[0];
		if (kind === "u") {
			throw new Error("Unmerged conflict entries detected; resolve conflicts before committing.");
		}
		if (kind === "?") {
			parsed.push({
				path: entry.slice(2),
				status: "??",
				untracked: true,
			});
			continue;
		}

		if (kind === "1") {
			const fields = entry.split(" ");
			const status = (fields[1] ?? "  ").replace(/\./g, " ");
			parsed.push({
				path: fields.slice(8).join(" "),
				status,
				untracked: false,
			});
			continue;
		}

		if (kind === "2") {
			const fields = entry.split(" ");
			const status = (fields[1] ?? "  ").replace(/\./g, " ");
			const renamedFrom = parts[index + 1];
			parsed.push({
				path: fields.slice(9).join(" "),
				status,
				untracked: false,
				...(renamedFrom ? { renamedFrom } : {}),
			});
			index++;
		}
	}

	return parsed
		.sort((left, right) => left.path.localeCompare(right.path))
		.map((file, index) => ({ ...file, id: index + 1, kind: changeKind(file), evidence: "" }));
}

async function loadEvidenceForFile(git: GitRunner, root: string, file: DirtyFile, hasHead: boolean): Promise<string> {
	if (file.untracked) return untrackedEvidence(root, file.path);
	if (file.kind === "deleted") return "deleted file; contents omitted";
	if (file.renamedFrom && !file.status.includes("M") && !file.status.includes("A") && !file.status.includes("D")) {
		return "renamed file; contents unchanged";
	}

	const paths = file.renamedFrom ? [file.renamedFrom, file.path] : [file.path];
	if (!hasHead) {
		const [staged, unstaged] = await Promise.all([
			git.run(["diff", "--cached", "--stat", "--patch", "--no-color", "--no-ext-diff", "--", ...paths], {
				cwd: root,
				optional: true,
			}),
			git.run(["diff", "--stat", "--patch", "--no-color", "--no-ext-diff", "--", ...paths], {
				cwd: root,
				optional: true,
			}),
		]);
		return truncAt(
			[staged && `staged diff:\n${staged}`, unstaged && `unstaged diff:\n${unstaged}`]
				.filter(Boolean)
				.join("\n\n") || "metadata-only change",
			MAX_FILE_EVIDENCE_CHARS,
		);
	}

	const diff = await git.run(["diff", "--stat", "--patch", "--no-color", "--no-ext-diff", "HEAD", "--", ...paths], {
		cwd: root,
		optional: true,
	});
	return truncAt(diff || "metadata-only change", MAX_FILE_EVIDENCE_CHARS);
}

async function untrackedEvidence(root: string, path: string): Promise<string> {
	try {
		const fullPath = join(root, path);
		const info = await stat(fullPath);
		if (!info.isFile()) return `untracked ${info.isDirectory() ? "directory" : "non-file"}`;
		if (info.size > MAX_UNTRACKED_PREVIEW_BYTES) return `untracked file, ${info.size} bytes`;
		const bytes = await readFile(fullPath);
		if (bytes.includes(0)) return `untracked binary file, ${info.size} bytes`;
		return truncAt(`untracked file preview:\n${bytes.toString("utf8")}`, MAX_FILE_EVIDENCE_CHARS);
	} catch (error) {
		return `untracked file preview unavailable: ${error instanceof Error ? error.message : String(error)}`;
	}
}

function changeKind(file: ParsedDirtyFile): DirtyFile["kind"] {
	if (file.untracked) return "untracked";
	if (file.renamedFrom) return "renamed";
	if (file.status.includes("D")) return "deleted";
	if (file.status.includes("A")) return "added";
	return "modified";
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

// Plan generation and validation

interface CommitMarker {
	hash: string;
	subject: string;
	timestamp: number;
}

interface CommitGroup {
	id: string;
	message: string;
	files: string[];
}

interface CommitPlanToolInput {
	commits: readonly CommitPlanToolCommit[];
}

interface CommitPlanToolCommit {
	message: string;
	allFiles: boolean;
	files: readonly number[];
}

interface CommitPlanState {
	files: readonly DirtyFile[];
	groups: CommitGroup[];
	worktreeSignature: string;
}

type CommitPlanReviewAction =
	| { kind: "cancel" }
	| { kind: "execute" }
	| { kind: "editMessage"; groupId: string }
	| { kind: "assignFiles"; groupId: string }
	| { kind: "newGroup" }
	| { kind: "deleteGroup"; groupId: string }
	| { kind: "moveGroup"; groupId: string; direction: -1 | 1 }
	| { kind: "regenerateMessage"; groupId: string }
	| { kind: "regeneratePlan" };

type CommitFilePickerResult = { kind: "cancel" } | { kind: "save"; files: string[] };

async function generatePlan(
	ctx: ExtensionCommandContext,
	evidence: CommitEvidence,
	previousPlan: readonly CommitGroup[] = [],
	regenerationNote = "",
): Promise<CommitGroup[]> {
	const prompt = buildPlanPrompt(evidence, previousPlan, regenerationNote);
	const pathById = new Map(evidence.files.map((file) => [file.id, file.path]));

	return generateToolValidated(
		ctx,
		await resolveCandidatesForPrompt(ctx, prompt),
		prompt,
		COMMIT_PLAN_TOOL,
		(input) => {
			if (!isCommitPlanToolInput(input)) throw new Error("Commit plan tool input is malformed.");
			const seen = new Set<string>();
			const groups: CommitGroup[] = [];
			for (const value of input.commits) {
				let files: string[] = [];
				if (value.allFiles) {
					if (input.commits.length !== 1) throw new Error("allFiles is only valid for a single-commit plan.");
					files = evidence.files.map((file) => file.path);
					for (const file of files) seen.add(file);
				} else {
					for (const fileId of value.files) {
						const path = pathById.get(fileId);
						if (!path) throw new Error(`Unknown dirty file ID in commit plan: ${fileId}`);
						if (seen.has(path)) continue;
						seen.add(path);
						files.push(path);
					}
				}
				if (files.length === 0) continue;

				groups.push({ id: randomUUID(), message: requireCommitMessage(value.message), files });
			}

			if (groups.length === 0) throw new Error("Commit plan produced no non-empty commits.");
			return groups;
		},
		(error, text) =>
			[
				`That commit plan failed validation: ${error.message}`,
				`Call ${COMMIT_PLAN_TOOL.name} again with corrected arguments only.`,
				"Use only numeric file IDs provided in the prompt.",
				"Set allFiles true only for a single all-files commit; then set files to an empty array.",
				"Previous response:",
				text,
			].join("\n"),
		{ statusKey: "commit", notifyOnFallback: true },
	);
}

async function regenerateMessage(
	ctx: ExtensionCommandContext,
	evidence: CommitEvidence,
	files: readonly string[],
	previousPlan: readonly CommitGroup[] = [],
	selectedGroupId: string | undefined = undefined,
	regenerationNote = "",
): Promise<string> {
	const selected = evidence.files.filter((file) => files.includes(file.path));
	const prompt = buildMessagePrompt(evidence, selected, previousPlan, selectedGroupId, regenerationNote);
	return generateValidated(
		ctx,
		await resolveCandidatesForPrompt(ctx, prompt),
		prompt,
		(text) => requireCommitMessage(text),
		undefined,
		{ statusKey: "commit", notifyOnFallback: true },
	);
}

function buildPlanPrompt(
	evidence: CommitEvidence,
	previousPlan: readonly CommitGroup[],
	regenerationNote: string,
): string {
	return [
		"Create the fewest useful commits for the dirty repository files.",
		`Call ${COMMIT_PLAN_TOOL.name} exactly once with the final plan.`,
		"File references must be numeric IDs only, never paths.",
		"Commit ladder:",
		"1. Can all dirty files be committed together with one honest conventional commit message a user would understand?",
		"   If yes, return one commit.",
		"2. For one all-files commit, set allFiles true and files to an empty array instead of listing every ID.",
		"3. If one message would be misleading, split off only files with a clearly different purpose.",
		"4. Keep README/docs/tests/prompts/UI text with the code change they describe or verify.",
		"5. Do not split by file type, directory, or conventional commit type alone.",
		"6. Leave unrelated/random files out only when they do not belong to any coherent commit.",
		"7. Use the minimum number of commits that preserves meaning.",
		"Rules:",
		"- Prefer fewer coherent commits over tidy-looking categories.",
		"- Use each dirty file at most once.",
		"- Use only numeric file IDs listed below.",
		"- Prefer conventional commit messages.",
		`- Allowed conventional commit types: ${CONVENTIONAL_COMMIT_TYPES}.`,
		"- Optional scope must be lowercase kebab-case, singular, and useful; omit it for broad or unrelated changes.",
		"- Subject must be one concise imperative line, no trailing period, max 100 characters.",
		"- Prefer exactly one line for non-breaking changes.",
		"- For breaking changes, prefer ! plus one body paragraph starting with BREAKING CHANGE:.",
		"Recent commit subjects are style guidance. User intent explains why. File evidence is authoritative.",
		"When regenerating, use the previous plan and user note to understand what to change; do not copy mistakes.",
		"",
		"Recent commit subjects:",
		evidence.recentSubjects || "(none)",
		"",
		"User intent since last commit:",
		formatIntent(evidence.intent),
		"",
		...formatRegenerationContext(evidence.files, previousPlan, undefined, regenerationNote),
		"File catalog:",
		formatFileCatalog(evidence.files),
		"",
		"File evidence:",
		truncAt(evidence.files.map(formatFileEvidence).join("\n\n"), MAX_PLAN_EVIDENCE_CHARS),
	].join("\n");
}

function buildMessagePrompt(
	evidence: CommitEvidence,
	files: readonly DirtyFile[],
	previousPlan: readonly CommitGroup[],
	selectedGroupId: string | undefined,
	regenerationNote: string,
): string {
	return [
		"Write one git commit message for the selected dirty files.",
		"Prefer this conventional commit format:",
		"<type>[optional scope][!]: <description>",
		`Allowed conventional commit types: ${CONVENTIONAL_COMMIT_TYPES}.`,
		"Prefer lowercase kebab-case scopes only when useful; omit scope for broad or unrelated changes.",
		"Prefer one concise imperative subject with no trailing period.",
		"For non-breaking changes, prefer one line and no body.",
		"For breaking changes, prefer ! plus one body paragraph starting with BREAKING CHANGE:.",
		"Do not wrap the message in markdown or code fences.",
		"When regenerating, use the previous plan, selected previous commit, and user note to understand what to change; do not copy mistakes.",
		"",
		"Recent commit subjects:",
		evidence.recentSubjects || "(none)",
		"",
		"User intent since last commit:",
		formatIntent(evidence.intent),
		"",
		...formatRegenerationContext(evidence.files, previousPlan, selectedGroupId, regenerationNote),
		"Selected files:",
		truncAt(files.map(formatFileEvidence).join("\n\n"), MAX_PLAN_EVIDENCE_CHARS),
	].join("\n");
}

function requireCommitMessage(rawMessage: string): string {
	const message = stripCodeFence(rawMessage)
		.replace(/^commit message:\s*/i, "")
		.trim();
	if (!message) throw new Error("Commit message is empty.");
	return message;
}

function isCommitPlanToolInput(value: unknown): value is CommitPlanToolInput {
	return isRecord(value) && Array.isArray(value.commits) && value.commits.every(isCommitPlanToolCommit);
}

function isCommitPlanToolCommit(value: unknown): value is CommitPlanToolCommit {
	return (
		isRecord(value) &&
		typeof value.message === "string" &&
		typeof value.allFiles === "boolean" &&
		Array.isArray(value.files) &&
		value.files.every((file) => typeof file === "number" && Number.isInteger(file))
	);
}

function formatFileCatalog(files: readonly DirtyFile[]): string {
	const groups = new Map<string, string[]>();
	for (const file of files) {
		const slash = file.path.lastIndexOf("/");
		const folder = slash >= 0 ? `${file.path.slice(0, slash)}/` : "./";
		const name = slash >= 0 ? file.path.slice(slash + 1) : file.path;
		const renamed = file.renamedFrom ? ` ← ${file.renamedFrom}` : "";
		const line = `  [${file.id}] ${file.status} ${name}${renamed}`;
		const lines = groups.get(folder);
		if (lines) lines.push(line);
		else groups.set(folder, [line]);
	}

	return [...groups.entries()].map(([folder, lines]) => [folder, ...lines].join("\n")).join("\n");
}

function formatFileEvidence(file: DirtyFile): string {
	return [
		`[${file.id}] ${file.status} ${file.path}`,
		file.renamedFrom && `Renamed from: ${file.renamedFrom}`,
		`Kind: ${file.kind}`,
		file.evidence,
	]
		.filter(Boolean)
		.join("\n");
}

function formatIntent(intent: readonly string[]): string {
	return intent.length > 0 ? intent.map((message, index) => `[${index + 1}]\n${message}`).join("\n\n") : "(none)";
}

function formatRegenerationContext(
	files: readonly DirtyFile[],
	previousPlan: readonly CommitGroup[],
	selectedGroupId: string | undefined,
	regenerationNote: string,
): string[] {
	if (previousPlan.length === 0 && !regenerationNote.trim()) return [];
	const idByPath = new Map(files.map((file) => [file.path, file.id]));
	return [
		"Previous commit plan:",
		previousPlan.length > 0
			? previousPlan
					.map((group, index) => {
						const selected = group.id === selectedGroupId ? " (selected)" : "";
						const groupFiles = group.files.map((file) => `- [${idByPath.get(file) ?? "?"}] ${file}`).join("\n");
						return `[${index + 1}]${selected}\nMessage: ${group.message}\nFiles:\n${groupFiles}`;
					})
					.join("\n\n")
			: "(none)",
		"",
		"User regeneration note:",
		regenerationNote.trim() || "(none)",
		"",
	];
}

function stripCodeFence(raw: string): string {
	const text = raw.trim();
	const fenced = text.match(/^```(?:gitcommit|json|text)?\s*\n([\s\S]*?)\n```$/i);
	const body = fenced?.[1];
	return body ? body.trim() : text;
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

	const bounded: string[] = [];
	let used = 0;
	for (let index = intent.length - 1; index >= 0; index--) {
		const message = intent[index];
		if (!message) continue;
		const remaining = MAX_INTENT_CHARS - used;
		if (remaining <= 0) break;
		const clipped = message.length > remaining ? truncAt(message, remaining) : message;
		bounded.push(clipped);
		used += clipped.length;
	}

	return bounded.reverse();
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

// Review UI

class CommitPlanReview implements Component {
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;
	private readonly state: CommitPlanState;
	private readonly done: (action: CommitPlanReviewAction) => void;
	private cursor = 0;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(
		tui: TUI,
		theme: Theme,
		keybindings: KeybindingsManager,
		state: CommitPlanState,
		selectedGroupId: string | undefined,
		done: (action: CommitPlanReviewAction) => void,
	) {
		this.tui = tui;
		this.theme = theme;
		this.keybindings = keybindings;
		this.state = state;
		this.done = done;
		const index = selectedGroupId ? state.groups.findIndex((group) => group.id === selectedGroupId) : -1;
		this.cursor = Math.max(0, index);
	}

	handleInput(data: string): void {
		if (this.keybindings.matches(data, "tui.select.confirm")) {
			this.done({ kind: "execute" });
			return;
		}
		if (this.keybindings.matches(data, "tui.select.cancel")) {
			this.done({ kind: "cancel" });
			return;
		}
		if (this.keybindings.matches(data, "tui.select.up")) {
			this.cursor = Math.max(0, this.cursor - 1);
			this.invalidate();
			this.tui.requestRender();
			return;
		}
		if (this.keybindings.matches(data, "tui.select.down")) {
			this.cursor = Math.min(Math.max(0, this.state.groups.length - 1), this.cursor + 1);
			this.invalidate();
			this.tui.requestRender();
			return;
		}
		if (data === "n") {
			this.done({ kind: "newGroup" });
			return;
		}
		if (data === "R") {
			this.done({ kind: "regeneratePlan" });
			return;
		}

		const group = this.state.groups[this.cursor];
		if (!group) return;
		if (data === "e") this.done({ kind: "editMessage", groupId: group.id });
		else if (data === "a") this.done({ kind: "assignFiles", groupId: group.id });
		else if (data === "r") this.done({ kind: "regenerateMessage", groupId: group.id });
		else if (data === "[") this.done({ kind: "moveGroup", groupId: group.id, direction: -1 });
		else if (data === "]") this.done({ kind: "moveGroup", groupId: group.id, direction: 1 });
		else if (matchesKey(data, Key.delete) || matchesKey(data, Key.backspace)) {
			this.done({ kind: "deleteGroup", groupId: group.id });
		}
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

		const renderWidth = Math.max(1, width);
		const assigned = new Set(this.state.groups.flatMap((group) => group.files));
		const unassigned = this.state.files.filter((file) => !assigned.has(file.path));
		const lines: string[] = [];
		lines.push(this.theme.fg("border", "─".repeat(renderWidth)));
		const summary = `${this.state.groups.length} commits · ${this.state.files.length} files · ${unassigned.length} unassigned`;
		lines.push(
			truncateToWidth(`${this.theme.bold("Commit plan")}  ${this.theme.fg("dim", summary)}`, renderWidth, ""),
		);
		lines.push("");

		const body = this.renderBody(renderWidth, unassigned);
		const visible = windowLines(body.lines, body.groupHeaderLines, this.cursor, MAX_VISIBLE_PLAN_LINES);
		lines.push(...visible.lines);
		if (visible.hidden > 0) {
			lines.push(
				this.theme.fg("dim", `  (${visible.hidden} more lines hidden; ${keyHint("tui.select.up", "scroll")})`),
			);
		}

		lines.push("");
		if (this.state.groups.some((group) => group.files.length === 0)) {
			lines.push(this.theme.fg("warning", " Empty commits are blocked before execution."));
		}
		lines.push(
			...wrapTextWithAnsi(
				this.theme.fg(
					"dim",
					[
						keyHint("tui.select.up", "move"),
						rawKeyHint("e", "edit"),
						rawKeyHint("a", "assign"),
						rawKeyHint("n", "new"),
						rawKeyHint("r", "regen msg"),
						rawKeyHint("shift+r", "regen plan"),
						rawKeyHint("[", "move up"),
						rawKeyHint("]", "move down"),
						rawKeyHint("delete", "delete"),
						keyHint("tui.select.confirm", "commit"),
						keyHint("tui.select.cancel", "cancel"),
					].join(" · "),
				),
				renderWidth,
			),
		);
		lines.push(this.theme.fg("border", "─".repeat(renderWidth)));

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	private renderBody(
		width: number,
		unassigned: readonly DirtyFile[],
	): {
		lines: string[];
		groupHeaderLines: number[];
	} {
		const lines: string[] = [];
		const groupHeaderLines: number[] = [];
		if (this.state.groups.length === 0) lines.push(this.theme.fg("warning", "  No commit groups."));
		for (const [index, group] of this.state.groups.entries()) {
			groupHeaderLines.push(lines.length);
			const active = index === this.cursor;
			const pointer = active ? this.theme.fg("accent", "> ") : "  ";
			const title = `${index + 1}  ${group.message}`;
			const count = this.theme.fg("dim", `  ${group.files.length} files`);
			lines.push(truncateToWidth(`${pointer}${active ? this.theme.bold(title) : title}${count}`, width, ""));
			for (const path of group.files.slice(0, active ? 8 : 3)) {
				const file = this.state.files.find((item) => item.path === path);
				lines.push(truncateToWidth(`     ${this.theme.fg("muted", file?.status ?? "??")} ${path}`, width, ""));
			}
			if (group.files.length > (active ? 8 : 3)) {
				lines.push(this.theme.fg("dim", `     … ${group.files.length - (active ? 8 : 3)} more`));
			}
			lines.push("");
		}

		if (unassigned.length > 0) {
			lines.push(this.theme.fg("warning", `  Unassigned (${unassigned.length})`));
			for (const file of unassigned.slice(0, 6)) {
				lines.push(truncateToWidth(`     ${this.theme.fg("muted", file.status)} ${file.path}`, width, ""));
			}
			if (unassigned.length > 6) lines.push(this.theme.fg("dim", `     … ${unassigned.length - 6} more`));
		}
		return { lines, groupHeaderLines };
	}
}

interface PickerFile {
	file: DirtyFile;
	owner?: CommitGroup;
}

class CommitFilePicker implements Component, Focusable {
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;
	private readonly title: string;
	private readonly files: readonly DirtyFile[];
	private readonly targetGroupId: string | undefined;
	private readonly ownerByPath: ReadonlyMap<string, CommitGroup>;
	private readonly done: (result: CommitFilePickerResult) => void;
	private readonly selected = new Set<string>();
	private readonly search = new Input();
	private cursor = 0;
	private _focused = false;

	constructor(
		tui: TUI,
		theme: Theme,
		keybindings: KeybindingsManager,
		title: string,
		files: readonly DirtyFile[],
		groups: readonly CommitGroup[],
		targetGroupId: string | undefined,
		initialFiles: readonly string[],
		preferUnassigned: boolean,
		done: (result: CommitFilePickerResult) => void,
	) {
		this.tui = tui;
		this.theme = theme;
		this.keybindings = keybindings;
		this.title = title;
		const owned = new Set(groups.flatMap((group) => group.files));
		this.files = preferUnassigned
			? [...files].sort(
					(left, right) =>
						Number(owned.has(left.path)) - Number(owned.has(right.path)) || left.path.localeCompare(right.path),
				)
			: files;
		this.targetGroupId = targetGroupId;
		this.ownerByPath = new Map(groups.flatMap((group) => group.files.map((file) => [file, group] as const)));
		this.done = done;
		for (const file of initialFiles) this.selected.add(file);
		this.search.focused = true;
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this.search.focused = value;
		this._focused = value;
	}

	handleInput(data: string): void {
		if (this.keybindings.matches(data, "tui.select.confirm")) {
			this.done({
				kind: "save",
				files: this.files.map((file) => file.path).filter((path) => this.selected.has(path)),
			});
			return;
		}
		if (this.keybindings.matches(data, "tui.select.cancel")) {
			this.done({ kind: "cancel" });
			return;
		}
		if (this.keybindings.matches(data, "tui.select.up") || this.keybindings.matches(data, "tui.select.down")) {
			const delta = this.keybindings.matches(data, "tui.select.up") ? -1 : 1;
			this.cursor = Math.max(0, Math.min(this.filtered.length - 1, this.cursor + delta));
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, Key.space)) {
			const item = this.filtered[this.cursor];
			if (item) {
				if (this.selected.has(item.file.path)) this.selected.delete(item.file.path);
				else this.selected.add(item.file.path);
				this.tui.requestRender();
			}
			return;
		}

		this.search.handleInput(data);
		this.cursor = Math.min(this.cursor, Math.max(0, this.filtered.length - 1));
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const renderWidth = Math.max(1, width);
		const titleSummary = `${this.selected.size} selected · ${this.files.length} files`;
		const titleLine = `${this.theme.bold(this.title)}  ${this.theme.fg("dim", titleSummary)}`;
		const lines = [
			this.theme.fg("border", "─".repeat(renderWidth)),
			truncateToWidth(titleLine, renderWidth, ""),
			...this.renderSearch(renderWidth),
			"",
		];

		lines.push(...this.renderFileList(this.filtered, renderWidth));
		lines.push("");
		lines.push(
			...wrapTextWithAnsi(
				this.theme.fg(
					"dim",
					[
						"type to filter",
						keyHint("tui.select.up", "move"),
						rawKeyHint("space", "toggle"),
						keyHint("tui.select.confirm", "save"),
						keyHint("tui.select.cancel", "cancel"),
					].join(" · "),
				),
				renderWidth,
			),
		);
		lines.push(this.theme.fg("border", "─".repeat(renderWidth)));
		return lines;
	}

	invalidate(): void {}

	private get filtered(): PickerFile[] {
		const query = this.search.getValue().trim().toLowerCase();
		const files = this.files.map((file) => ({ file, owner: this.ownerByPath.get(file.path) }));
		if (!query) return files;
		return files.filter((item) =>
			[item.file.path, item.file.status, item.owner?.message ?? "unassigned"]
				.join(" ")
				.toLowerCase()
				.includes(query),
		);
	}

	private renderSearch(width: number): string[] {
		const body = this.search.render(Math.max(1, width - "search: ".length));
		return [truncateToWidth(`${this.theme.fg("muted", "search: ")}${body[0] ?? ""}`, width, "")];
	}

	private renderFileList(filtered: readonly PickerFile[], width: number): string[] {
		if (filtered.length === 0) return [this.theme.fg("muted", "  No matching files")];
		const maxVisible = 14;
		const start = Math.max(0, Math.min(this.cursor - Math.floor(maxVisible / 2), filtered.length - maxVisible));
		const visible = filtered.slice(start, start + maxVisible);
		const lines = visible.flatMap((item, offset) => this.renderItem(item, start + offset === this.cursor, width));
		if (start > 0 || start + visible.length < filtered.length) {
			lines.push(this.theme.fg("dim", `  (${this.cursor + 1}/${filtered.length})`));
		}
		return lines;
	}

	private renderItem(item: PickerFile, active: boolean, width: number): string[] {
		const checked = this.selected.has(item.file.path);
		const pointer = active ? this.theme.fg("accent", "> ") : "  ";
		const box = checked ? this.theme.fg("success", "[x]") : this.theme.fg("dim", "[ ]");
		let ownerText = "";
		if (item.owner) {
			ownerText =
				item.owner.id === this.targetGroupId
					? "current"
					: `currently: ${item.owner.message.split("\n")[0] ?? item.owner.message}`;
			ownerText = this.theme.fg(item.owner.id === this.targetGroupId ? "success" : "muted", `  ${ownerText}`);
		}
		const path = active ? this.theme.bold(item.file.path) : item.file.path;
		return [
			truncateToWidth(`${pointer}${box} ${this.theme.fg("muted", item.file.status)} ${path}${ownerText}`, width, ""),
		];
	}
}

function windowLines(
	body: readonly string[],
	groupHeaderLines: readonly number[],
	cursor: number,
	maxVisible: number,
): { lines: string[]; hidden: number } {
	if (body.length <= maxVisible) return { lines: [...body], hidden: 0 };
	const headerLine = groupHeaderLines[cursor] ?? 0;
	const half = Math.floor(maxVisible / 2);
	const start = Math.max(0, Math.min(headerLine - half, body.length - maxVisible));
	const slice = body.slice(start, start + maxVisible);
	return { lines: slice, hidden: body.length - slice.length };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
