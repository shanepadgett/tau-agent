import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { createGitRunner, type GitRunner } from "../../shared/git.ts";
import { errorText } from "../../shared/text.ts";
import { acquireWorkspace, registerWorkspaceSession, workspaceOwner, type WorkspaceLease } from "./ownership.ts";
import { showWorkspacePanel } from "./panel.ts";
import { prepareWorkspaceSession } from "./sessions.ts";
import {
	createWorkspace,
	cleanupMissingWorkspace,
	discoverRepository,
	discoverWorkspaces,
	inspectRemoval,
	removeWorkspace,
	saveWorkspaceRecord,
	validateWorkspace,
	type Repository,
	type Workspace,
} from "./workspaces.ts";

export default function worktreeExtension(pi: ExtensionAPI): void {
	let releaseSession: (() => Promise<void>) | null = null;
	pi.on("session_start", async (_event, ctx) => {
		try {
			if (releaseSession) {
				await releaseSession();
				releaseSession = null;
			}
			const git = createGitRunner(pi, ctx);
			const root = await git.run(["rev-parse", "--show-toplevel"], { optional: true });
			if (!root) return;
			const { repository, workspaces } = await discoverWorkspaces(git);
			const current = workspaces.find((workspace) => workspace.current);
			if (!current) throw new Error("Cannot identify this Git workspace.");
			await validateWorkspace(git, repository, current);
			const session = await registerWorkspaceSession(repository.store, current.path);
			releaseSession = session.release;
			if (session.otherOwner) {
				ctx.ui.notify(
					`Another Tau session is using this checkout (${session.otherOwner}). Concurrent edits, checks, and Git operations can interfere with each other. Use separate worktrees for independent edits.`,
					"warning",
				);
			}
			if (current.errors.length) ctx.ui.notify(current.errors.join("\n"), "warning");
			if (current.record && !session.otherOwner) {
				await saveWorkspaceRecord(repository, {
					...current.record,
					sessionPath: ctx.sessionManager.getSessionFile() ?? null,
				});
			}
		} catch (error) {
			ctx.ui.notify(`Worktree tracking failed: ${errorText(error)}`, "warning");
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		try {
			if (releaseSession) await releaseSession();
		} catch (error) {
			ctx.ui.notify(`Could not release workspace session tracking: ${errorText(error)}`, "warning");
		} finally {
			releaseSession = null;
		}
	});

	pi.registerCommand("wt", {
		description: "Copy this checkout into a new worktree; list or clean workspaces",
		getArgumentCompletions(prefix): AutocompleteItem[] | null {
			const value = prefix.trimStart();
			if (/\s/.test(value)) return null;
			return [
				{ value: "list", label: "list", description: "Browse workspaces and resume their sessions" },
				{ value: "clean", label: "clean", description: "Review removal of unused, clean Tau worktrees" },
			].filter((item) => item.value.startsWith(value));
		},
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/wt requires interactive TUI mode.", "error");
				return;
			}
			await ctx.waitForIdle();
			const action = args.trim();
			if (action && action !== "list" && action !== "clean") {
				ctx.ui.notify("Usage: /wt, /wt list, /wt clean", "error");
				return;
			}
			const git = createGitRunner(pi, ctx);
			try {
				if (!action) {
					const { repository } = await discoverRepository(git);
					await newWorkspace(pi, ctx, git, repository);
					return;
				}
				const { repository, workspaces } = await discoverWorkspaces(git);
				if (action === "clean") {
					const candidates = workspaces.filter(
						(workspace) =>
							workspace.record &&
							!workspace.main &&
							!workspace.current &&
							!workspace.missing &&
							!workspace.locked &&
							!workspace.owner &&
							workspace.changes === 0 &&
							workspace.errors.length === 0,
					);
					await deleteWorkspaces(ctx, git, repository, candidates);
					return;
				}
				const selected = await showWorkspacePanel(ctx, workspaces);
				if (!selected) return;
				const terminal = detectTabTerminal();
				const choices = [
					...(!selected.missing
						? ["Switch here", terminal ? `Open in a new ${terminal} tab` : "Show terminal command"]
						: []),
					"Show details",
					...(selected.missing && !selected.main ? ["Clean up missing registration"] : []),
					...(selected.record && !selected.main && !selected.current && !selected.missing
						? ["Remove workspace"]
						: []),
				];
				const choice = await ctx.ui.select(selected.name, choices);
				if (!choice) return;
				if (choice === "Show details") {
					await ctx.ui.select(selected.name, [
						`Folder: ${selected.path}`,
						`Branch: ${selected.branch ?? "detached HEAD"}`,
						`Current commit: ${selected.head}`,
						`Starting commit: ${selected.record?.baseCommit ?? "not managed by Tau"}`,
						`Active sessions: ${selected.owner ?? "none detected"}`,
						`Folder status: ${selected.missing ? "missing" : "present"}`,
						...selected.errors.map((error) => `Error: ${error}`),
						"Close",
					]);
				} else if (choice === "Clean up missing registration") {
					if (!selected.missing || selected.main || selected.current)
						throw new Error("Select a missing linked worktree registration to clean up.");
					if (selected.locked) throw new Error("This worktree is locked. Unlock it yourself before cleanup.");
					const lease = await acquireWorkspace(repository.store, selected.path);
					try {
						const confirmed = await ctx.ui.confirm(
							`Clean up ${selected.name}?`,
							[
								`Remove only the missing Git worktree registration and Tau workspace metadata for: ${selected.path}`,
								"Keep branches and saved conversations. No other registrations will be removed.",
								"WARNING: A missing folder may be on an unmounted drive. Restore or mount it instead if you intend to keep using this worktree.",
							].join("\n"),
						);
						if (!confirmed) return;
						if (!(await lease.valid())) throw new Error("Removal ownership was lost. Cleanup cancelled.");
						await cleanupMissingWorkspace(git, repository, selected);
						ctx.ui.notify(`Cleaned up ${selected.name}. Its branch and saved conversations remain.`, "info");
					} finally {
						await lease.release();
					}
				} else if (choice === "Remove workspace") {
					await deleteWorkspaces(ctx, git, repository, [selected]);
				} else {
					await openWorkspace(
						pi,
						ctx,
						git,
						repository,
						selected,
						choice === "Switch here" ? "switch" : "terminal",
						"resume",
					);
				}
			} catch (error) {
				ctx.ui.notify(`Worktree operation failed: ${errorText(error)}`, "error");
			}
		},
	});
}

function detectTabTerminal(): "cmux" | "Ghostty" | null {
	if (process.env.CMUX_WORKSPACE_ID) return "cmux";
	if (process.platform === "darwin" && process.env.TERM_PROGRAM === "ghostty") return "Ghostty";
	return null;
}

async function newWorkspace(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	git: GitRunner,
	repository: Repository,
): Promise<void> {
	ctx.ui.notify("Copying this checkout into a new worktree…", "info");
	const record = await createWorkspace(git, repository, ctx.signal);
	const workspace: Workspace = {
		id: record.path,
		name: record.name,
		path: record.path,
		branch: record.branch,
		head: record.baseCommit,
		main: false,
		current: false,
		locked: false,
		missing: false,
		changes: null,
		owner: null,
		record,
		errors: [],
	};
	await openWorkspace(
		pi,
		ctx,
		git,
		repository,
		workspace,
		detectTabTerminal() === "cmux" ? "terminal" : "switch",
		"continue",
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
	if (workspace.current && destination === "switch") {
		ctx.ui.notify("You are already in this workspace. Use its existing Pi instance.", "info");
		return;
	}
	await validateWorkspace(git, repository, workspace);
	let owner: string | null = null;
	let association: "save" | "preserve" = "save";
	try {
		owner = await workspaceOwner(repository.store, workspace.path);
	} catch (error) {
		ctx.ui.notify(`Cannot inspect active sessions: ${errorText(error)}. Opening a fresh chat.`, "warning");
		conversation = "fresh";
		association = "preserve";
	}
	if (owner) {
		ctx.ui.notify(
			"This checkout is already in use. Concurrent edits, checks, and Git operations can interfere. Opening a separate chat to avoid sharing its session file.",
			"warning",
		);
		if (conversation === "resume") conversation = "fresh";
		association = "preserve";
	}
	const sessionPath = await prepareWorkspaceSession(
		ctx,
		repository,
		workspace,
		conversation,
		association,
		pi.getThinkingLevel(),
	);
	if (destination === "terminal") {
		const quotedPath = `'${workspace.path.replace(/'/g, "'\\''")}'`;
		const quotedSession = `'${sessionPath.replace(/'/g, "'\\''")}'`;
		const command = `cd ${quotedPath} && pi --session ${quotedSession}`;
		const tabTerminal = detectTabTerminal();
		if (tabTerminal === "cmux") {
			const created = await pi.exec(
				"cmux",
				["new-surface", "--working-directory", workspace.path, "--focus", "true"],
				{
					signal: ctx.signal,
					timeout: 10_000,
				},
			);
			const surface = created.stdout.match(/surface:\d+/)?.[0];
			if (created.code === 0 && surface) {
				const sent = await pi.exec("cmux", ["send", "--surface", surface, "--", `${command}\\n`], {
					signal: ctx.signal,
					timeout: 10_000,
				});
				if (sent.code === 0) {
					await pi.exec("cmux", ["rename-tab", "--surface", surface, workspace.name], {
						signal: ctx.signal,
						timeout: 10_000,
					});
					ctx.ui.notify(`Opened ${workspace.name} in a new cmux tab.`, "info");
					return;
				}
			}
			ctx.ui.notify("Could not open a cmux tab. Showing the command instead.", "warning");
		} else if (tabTerminal === "Ghostty") {
			const opened = await pi.exec(
				"osascript",
				[
					"-e",
					"on run argv",
					"-e",
					'tell application "Ghostty"',
					"-e",
					"new tab in front window with configuration {initial working directory:item 1 of argv, initial input:(item 2 of argv) & linefeed}",
					"-e",
					"end tell",
					"-e",
					"end run",
					workspace.path,
					command,
				],
				{ signal: ctx.signal, timeout: 10_000 },
			);
			if (opened.code === 0) {
				ctx.ui.notify(`Opened ${workspace.name} in a new Ghostty tab.`, "info");
				return;
			}
			ctx.ui.notify("Could not open a Ghostty tab. Showing the command instead.", "warning");
		}
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

async function deleteWorkspaces(
	ctx: ExtensionCommandContext,
	git: GitRunner,
	repository: Repository,
	workspaces: readonly Workspace[],
): Promise<void> {
	const plan: {
		workspace: Workspace;
		lease: WorkspaceLease;
		evidence: Awaited<ReturnType<typeof inspectRemoval>>;
	}[] = [];
	try {
		for (const workspace of workspaces) {
			let lease: WorkspaceLease | null = null;
			try {
				lease = await acquireWorkspace(repository.store, workspace.path);
				const evidence = await inspectRemoval(git, repository, workspace);
				plan.push({ workspace, lease, evidence });
			} catch (error) {
				if (lease) await lease.release();
				ctx.ui.notify(`Skipped ${workspace.name}: ${errorText(error)}`, "warning");
			}
		}
		if (!plan.length) {
			ctx.ui.notify("No unused, clean Tau worktrees to remove.", "info");
			return;
		}
		const confirmed = await ctx.ui.confirm(
			`Remove ${plan.length} worktree(s)?`,
			[
				...plan.map(({ workspace, evidence }) =>
					[
						`Delete folder: ${workspace.path}`,
						`Keep branch: ${workspace.branch?.replace(/^refs\/heads\//, "")}. ${evidence.uniqueCommits} commit(s) are not on other branches/remotes.`,
						evidence.ignored
							? `WARNING: ${evidence.ignored} ignored local file(s), including dependencies and environment files, will be deleted.`
							: "No ignored local files found.",
					].join("\n"),
				),
				"All branches and saved conversations remain.",
			].join("\n"),
		);
		if (!confirmed) return;
		for (const { workspace, lease, evidence } of plan) {
			try {
				if (!(await lease.valid())) throw new Error("Workspace ownership was lost. Removal cancelled.");
				const current = await inspectRemoval(git, repository, workspace);
				if (current.signature !== evidence.signature)
					throw new Error("Workspace changed during confirmation. Review removal again.");
				await removeWorkspace(git, repository, workspace);
				ctx.ui.notify(`Removed ${workspace.name}. Its branch and saved conversations remain.`, "info");
			} catch (error) {
				ctx.ui.notify(`Could not remove ${workspace.name}: ${errorText(error)}`, "warning");
			}
		}
	} finally {
		for (const { workspace, lease } of plan) {
			try {
				await lease.release();
			} catch (error) {
				ctx.ui.notify(`Could not release the removal lock for ${workspace.path}: ${errorText(error)}`, "warning");
			}
		}
	}
}
