import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { createGitRunner, type GitRunner } from "../../shared/git.ts";
import { loadTauExtensionSettings } from "../../shared/settings/load.ts";
import { errorText } from "../../shared/text.ts";
import { acquireWorkspace, type WorkspaceLease } from "./ownership.ts";
import { showWorkspacePanel } from "./panel.ts";
import { prepareWorkspaceSession } from "./sessions.ts";
import worktreeSettings from "./settings.ts";
import {
	createWorkspace,
	discoverWorkspaces,
	inspectRemoval,
	removeWorkspace,
	saveWorkspaceRecord,
	validateWorkspace,
	type Repository,
	type Workspace,
} from "./workspaces.ts";

type Ownership = { kind: "outside" } | { kind: "owned"; lease: WorkspaceLease } | { kind: "blocked"; reason: string };

export default function worktreeExtension(pi: ExtensionAPI): void {
	let ownership: Ownership = { kind: "outside" };
	pi.on("session_start", async (_event, ctx) => {
		const git = createGitRunner(pi, ctx);
		const root = await git.run(["rev-parse", "--show-toplevel"], { optional: true });
		if (!root) return;
		try {
			const { repository, workspaces } = await discoverWorkspaces(git);
			const current = workspaces.find((workspace) => workspace.current);
			if (!current) throw new Error("Cannot identify this Git workspace.");
			await validateWorkspace(git, repository, current);
			ownership = { kind: "owned", lease: await acquireWorkspace(repository.store, current.path) };
			if (current.record) {
				await saveWorkspaceRecord(repository, {
					...current.record,
					sessionPath: ctx.sessionManager.getSessionFile() ?? null,
				});
			}
		} catch (error) {
			if (ownership.kind === "owned") {
				try {
					await ownership.lease.release();
				} catch (releaseError) {
					ctx.ui.notify(`Could not release workspace ownership: ${errorText(releaseError)}`, "warning");
				}
			}
			const reason = errorText(error);
			ownership = { kind: "blocked", reason };
			ctx.ui.notify(`${reason} Use /worktree to choose another workspace.`, "error");
		}
	});

	pi.on("tool_call", async () => {
		if (ownership.kind === "outside") return;
		if (ownership.kind === "owned" && (await ownership.lease.valid())) return;
		return {
			block: true,
			reason:
				ownership.kind === "blocked"
					? ownership.reason
					: "Workspace ownership was lost. Switch workspaces with /worktree before running tools.",
		};
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		try {
			if (ownership.kind === "owned") await ownership.lease.release();
		} catch (error) {
			ctx.ui.notify(`Could not release workspace ownership: ${errorText(error)}`, "warning");
		} finally {
			ownership = { kind: "outside" };
		}
	});

	pi.registerCommand("worktree", {
		description: "Create, open, and safely remove feature workspaces",
		getArgumentCompletions(prefix): AutocompleteItem[] | null {
			const value = prefix.trimStart();
			if (/\s/.test(value)) return null;
			return [
				{ value: "new", label: "new", description: "Create a feature workspace" },
				{ value: "open", label: "open", description: "Resume a workspace session" },
				{ value: "remove", label: "remove", description: "Review and remove a workspace" },
			].filter((item) => item.value.startsWith(value));
		},
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/worktree requires interactive TUI mode.", "error");
				return;
			}
			await ctx.waitForIdle();
			const [action = "", ...rest] = args.trim().split(/\s+/);
			if (action && !["new", "open", "remove"].includes(action)) {
				ctx.ui.notify(
					"Usage: /worktree, /worktree new [name], /worktree open <name>, /worktree remove <name>",
					"error",
				);
				return;
			}
			const git = createGitRunner(pi, ctx);
			try {
				const { repository, workspaces } = await discoverWorkspaces(git);
				if (action === "new") {
					await newWorkspace(pi, ctx, git, repository, rest.join(" "));
					return;
				}
				let selected: Workspace | "new" | undefined;
				const name = rest.join(" ");
				if (name) {
					const matches = workspaces.filter(
						(workspace) =>
							workspace.name === name || workspace.path === name || workspace.branch === `refs/heads/${name}`,
					);
					if (matches.length !== 1)
						throw new Error(
							matches.length
								? "Workspace name is ambiguous. Select it with /worktree."
								: `No workspace named ${name}.`,
						);
					selected = matches[0];
				} else {
					selected = await showWorkspacePanel(ctx, workspaces);
				}
				if (!selected) return;
				if (selected === "new") {
					await newWorkspace(pi, ctx, git, repository, "");
					return;
				}
				let operation = action;
				if (!operation) {
					const choices = [
						"Open session",
						"Show terminal command",
						"Show details",
						...(selected.record && !selected.current ? ["Remove workspace"] : []),
					];
					const choice = await ctx.ui.select(selected.name, choices);
					if (!choice) return;
					operation =
						choice === "Open session"
							? "open"
							: choice === "Remove workspace"
								? "remove"
								: choice === "Show details"
									? "details"
									: "terminal";
				}
				if (operation === "details") {
					await ctx.ui.select(selected.name, [
						`Folder: ${selected.path}`,
						`Branch: ${selected.branch ?? "detached HEAD"}`,
						`Current commit: ${selected.head}`,
						`Starting commit: ${selected.record?.baseCommit ?? "not managed by Tau"}`,
						`Owner: ${selected.owner ?? "available"}`,
						"Close",
					]);
				} else if (operation === "remove") {
					await deleteWorkspace(ctx, git, repository, selected);
				} else {
					await openWorkspace(
						pi,
						ctx,
						git,
						repository,
						selected,
						operation === "terminal" ? "terminal" : "switch",
						"resume",
					);
				}
			} catch (error) {
				ctx.ui.notify(`Worktree operation failed: ${errorText(error)}`, "error");
			}
		},
	});
}

async function newWorkspace(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	git: GitRunner,
	repository: Repository,
	requestedName: string,
): Promise<void> {
	const input = requestedName || (await ctx.ui.input("Feature name", "csv-export"));
	if (input === undefined) return;
	const name = input
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "");
	if (!name) throw new Error("Feature name must contain letters or numbers.");
	const refs = (await git.run(["for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes"]))
		.split("\n")
		.filter((ref) => ref && !ref.endsWith("/HEAD"));
	const defaultRef = await git.run(["symbolic-ref", "refs/remotes/origin/HEAD"], { optional: true });
	const main = refs.includes("refs/heads/main")
		? "refs/heads/main"
		: refs.includes("refs/heads/master")
			? "refs/heads/master"
			: defaultRef || "HEAD";
	const start = await ctx.ui.select("Start from", [
		`Main / default branch (${main.replace(/^refs\/(heads|remotes)\//, "")})`,
		"Current branch (committed changes only)",
		"Choose another branch",
	]);
	if (!start) return;
	let base = start.startsWith("Main / default") ? main : "HEAD";
	if (start === "Choose another branch") {
		const choice = await ctx.ui.select("Starting branch", refs);
		if (!choice) return;
		base = choice;
	}
	const { setupCommand } = await loadTauExtensionSettings(ctx, worktreeSettings);
	const baseCommit = await git.run(["rev-parse", "--verify", "--end-of-options", `${base}^{commit}`]);
	const status = await git.run(["status", "--porcelain=v1", "--untracked-files=all"]);
	const conversation = await ctx.ui.select("Conversation", ["Start a fresh chat", "Continue this chat"]);
	if (!conversation) return;
	const destination = await ctx.ui.select("Open workspace", ["Switch here", "Open in a separate terminal"]);
	if (!destination) return;
	const confirmed = await ctx.ui.confirm(
		`Create ${name}?`,
		[
			`Branch: feature/${name}`,
			`Starting from: ${base} (${baseCommit.slice(0, 12)})`,
			`Folder: ${repository.folder}/${name}`,
			status
				? `${status.split("\n").filter(Boolean).length} unfinished file(s) will NOT be included (uncommitted changes and untracked files).`
				: "Only committed files are included.",
			setupCommand
				? `Setup command, run in the new folder before opening: ${setupCommand}`
				: "Install dependencies and configure local environment files in the new folder as needed.",
		].join("\n"),
	);
	if (!confirmed) return;
	const record = await createWorkspace(git, repository, name, baseCommit);
	const { workspaces } = await discoverWorkspaces(git);
	const workspace = workspaces.find((item) => item.path === record.path);
	if (!workspace)
		throw new Error(
			`Workspace was created at ${record.path}, but could not be discovered. Reopen it with /worktree.`,
		);
	if (setupCommand) {
		let succeeded = false;
		while (!succeeded) {
			ctx.ui.notify(`Running setup in ${workspace.path}: ${setupCommand}`, "info");
			const result = await pi.exec("sh", ["-c", setupCommand], {
				cwd: workspace.path,
				signal: ctx.signal,
				timeout: 600_000,
			});
			succeeded = result.code === 0;
			if (succeeded) break;
			const details = [result.stderr, result.stdout]
				.filter(Boolean)
				.join("\n")
				.trim()
				.split("\n")
				.slice(-15)
				.join("\n");
			const retry = await ctx.ui.confirm(
				"Setup failed. Retry?",
				`${setupCommand} exited with code ${result.code} in ${workspace.path}.\n${details}\nChoose No to stop; the workspace remains available through /worktree.`,
			);
			if (!retry) return;
		}
	}
	await openWorkspace(
		pi,
		ctx,
		git,
		repository,
		workspace,
		destination === "Switch here" ? "switch" : "terminal",
		conversation === "Continue this chat" ? "continue" : "fresh",
	);
}

async function openWorkspace(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	git: GitRunner,
	repository: Repository,
	workspace: Workspace,
	destination: "switch" | "terminal",
	conversation: "fresh" | "continue" | "resume",
): Promise<void> {
	if (workspace.current) {
		ctx.ui.notify("You are already in this workspace. Use its existing Pi instance.", "info");
		return;
	}
	await validateWorkspace(git, repository, workspace);
	const lease = await acquireWorkspace(repository.store, workspace.path);
	let sessionPath: string;
	try {
		sessionPath = await prepareWorkspaceSession(ctx, repository, workspace, conversation, pi.getThinkingLevel());
	} finally {
		await lease.release();
	}
	if (destination === "terminal") {
		const quotedPath = `'${workspace.path.replace(/'/g, "'\\''")}'`;
		const quotedSession = `'${sessionPath.replace(/'/g, "'\\''")}'`;
		const command = `cd ${quotedPath} && pi --session ${quotedSession}`;
		await ctx.ui.editor("Run this in a second terminal", command);
		return;
	}
	const draft = conversation === "continue" ? ctx.ui.getEditorText() : "";
	await ctx.switchSession(sessionPath, {
		withSession: async (replacementCtx) => {
			if (draft) replacementCtx.ui.setEditorText(draft);
			replacementCtx.ui.notify(`Opened ${workspace.name}: ${workspace.path}`, "info");
		},
	});
}

async function deleteWorkspace(
	ctx: ExtensionCommandContext,
	git: GitRunner,
	repository: Repository,
	workspace: Workspace,
): Promise<void> {
	const lease = await acquireWorkspace(repository.store, workspace.path);
	try {
		const evidence = await inspectRemoval(git, repository, workspace);
		const confirmed = await ctx.ui.confirm(
			`Remove ${workspace.name}?`,
			[
				`Delete folder: ${workspace.path}`,
				`Keep branch: ${workspace.branch?.replace(/^refs\/heads\//, "")}`,
				`Keep saved conversations. ${evidence.uniqueCommits} commit(s) are not on other branches/remotes; the retained branch preserves them.`,
				evidence.ignored
					? `WARNING: ${evidence.ignored} ignored local file(s), including any dependencies or environment files, will be deleted.`
					: "No ignored local files found.",
			].join("\n"),
		);
		if (!confirmed) return;
		if (!(await lease.valid())) throw new Error("Workspace ownership was lost. Removal cancelled.");
		const current = await inspectRemoval(git, repository, workspace);
		if (current.signature !== evidence.signature)
			throw new Error("Workspace changed during confirmation. Review removal again.");
		await removeWorkspace(git, repository, workspace);
		ctx.ui.notify(`Removed ${workspace.name}. Its branch and saved conversations remain.`, "info");
	} finally {
		await lease.release();
	}
}
