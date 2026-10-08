import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { createGitRunner, type GitRunner } from "../../shared/git.ts";
import { loadTauExtensionSettings } from "../../shared/settings/load.ts";
import { errorText } from "../../shared/text.ts";
import { acquireWorkspace, registerWorkspaceSession, workspaceOwner } from "./ownership.ts";
import { showWorkspacePanel } from "./panel.ts";
import { prepareWorkspaceSession } from "./sessions.ts";
import worktreeSettings from "./settings.ts";
import {
	createWorkspace,
	cleanupMissingWorkspace,
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
		const git = createGitRunner(pi, ctx);
		const root = await git.run(["rev-parse", "--show-toplevel"], { optional: true });
		if (!root) return;
		try {
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

	pi.registerCommand("worktree", {
		description: "Create, open, and safely remove feature workspaces",
		getArgumentCompletions(prefix): AutocompleteItem[] | null {
			const value = prefix.trimStart();
			if (/\s/.test(value)) return null;
			return [
				{ value: "new", label: "new", description: "Create a feature workspace" },
				{ value: "open", label: "open", description: "Resume a workspace session" },
				{ value: "remove", label: "remove", description: "Review and remove a workspace" },
				{ value: "cleanup", label: "cleanup", description: "Clean up a missing worktree registration" },
			].filter((item) => item.value.startsWith(value));
		},
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/worktree requires interactive TUI mode.", "error");
				return;
			}
			await ctx.waitForIdle();
			const [action = "", ...rest] = args.trim().split(/\s+/);
			if (action && !["new", "open", "remove", "cleanup"].includes(action)) {
				ctx.ui.notify(
					"Usage: /worktree, /worktree new [name], /worktree open <name>, /worktree remove <name>, /worktree cleanup <name>",
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
						...(!selected.missing ? ["Open session", "Show terminal command"] : []),
						"Show details",
						...(selected.missing && !selected.main ? ["Clean up missing registration"] : []),
						...(selected.record && !selected.current && !selected.missing ? ["Remove workspace"] : []),
					];
					const choice = await ctx.ui.select(selected.name, choices);
					if (!choice) return;
					operation =
						choice === "Clean up missing registration"
							? "cleanup"
							: choice === "Open session"
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
						`Active sessions: ${selected.owner ?? "none detected"}`,
						`Folder status: ${selected.missing ? "missing" : "present"}`,
						...selected.errors.map((error) => `Error: ${error}`),
						"Close",
					]);
				} else if (operation === "cleanup") {
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
	const tabTerminal = detectTabTerminal();
	const tabChoice = tabTerminal ? `Open in a new ${tabTerminal} tab` : "Open in a separate terminal";
	const destination = await ctx.ui.select(
		"Open workspace",
		tabTerminal ? [tabChoice, "Switch here"] : ["Switch here", tabChoice],
	);
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
