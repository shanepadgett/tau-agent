import { createHash } from "node:crypto";
import { lstat, mkdir, realpath, rm, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { GitRunner } from "../../shared/git.ts";
import { readJsonStatus, writeJsonObject } from "../../shared/settings/json.ts";
import { workspaceOwner, workspaceStorage } from "./ownership.ts";
import { errorText } from "../../shared/text.ts";

export interface WorkspaceRecord {
	name: string;
	path: string;
	branch: string;
	baseCommit: string;
	sessionPath: string | null;
}

export interface Repository {
	root: string;
	commonDir: string;
	store: string;
	folder: string;
}

export interface Workspace {
	id: string;
	name: string;
	path: string;
	branch: string | null;
	head: string;
	main: boolean;
	current: boolean;
	locked: boolean;
	missing: boolean;
	changes: number | null;
	owner: string | null;
	record: WorkspaceRecord | null;
	errors: string[];
}

export async function loadWorkspaceRecord(repository: Repository, path: string): Promise<WorkspaceRecord | null> {
	const status = await readJsonStatus(`${workspaceStorage(repository.store, path)}.json`);
	if (!status.exists) return null;
	if (!status.ok) throw new Error(`Cannot read workspace metadata: ${status.error}`);
	const value = status.value;
	if (
		value.version !== 1 ||
		typeof value.name !== "string" ||
		value.path !== path ||
		typeof value.branch !== "string" ||
		typeof value.baseCommit !== "string" ||
		!(value.sessionPath === null || typeof value.sessionPath === "string")
	) {
		throw new Error(`Invalid workspace metadata for ${path}.`);
	}
	return {
		name: value.name,
		path,
		branch: value.branch,
		baseCommit: value.baseCommit,
		sessionPath: value.sessionPath,
	};
}

export async function saveWorkspaceRecord(repository: Repository, record: WorkspaceRecord): Promise<void> {
	await writeJsonObject(`${workspaceStorage(repository.store, record.path)}.json`, { version: 1, ...record });
}

export async function discoverWorkspaces(git: GitRunner): Promise<{ repository: Repository; workspaces: Workspace[] }> {
	const root = await realpath(await git.run(["rev-parse", "--show-toplevel"]));
	const commonDir = await realpath(await git.run(["rev-parse", "--path-format=absolute", "--git-common-dir"]));
	const key = createHash("sha256").update(commonDir).digest("hex");
	const repository: Repository = {
		root,
		commonDir,
		store: join(getAgentDir(), "tau", "worktrees", key),
		folder: "",
	};
	const output = await git.run(["worktree", "list", "--porcelain", "-z"]);
	const blocks = output.split("\0\0").filter(Boolean);
	const workspaces: Workspace[] = [];
	for (const block of blocks) {
		const fields = block.split("\0");
		const registeredPath = fields.find((field) => field.startsWith("worktree "))?.slice(9);
		if (!registeredPath || fields.includes("bare")) continue;
		let path = resolve(registeredPath);
		let missing = false;
		const errors: string[] = [];
		try {
			path = await realpath(path);
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ENOENT") missing = true;
			else errors.push(`Cannot resolve folder: ${errorText(error)}`);
		}
		const branch = fields.find((field) => field.startsWith("branch "))?.slice(7) ?? null;
		const head = fields.find((field) => field.startsWith("HEAD "))?.slice(5) ?? "";
		let record: WorkspaceRecord | null = null;
		try {
			record = await loadWorkspaceRecord(repository, path);
		} catch (error) {
			errors.push(errorText(error));
		}
		let changes: number | null = null;
		if (!missing) {
			try {
				const status = await git.run(["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd: path });
				const entries = status.split("\0").filter(Boolean);
				changes = 0;
				for (let index = 0; index < entries.length; index++) {
					changes++;
					if (/^[RC]|^.[RC]/.test(entries[index] ?? "")) index++;
				}
			} catch (error) {
				errors.push(`Cannot inspect changes: ${errorText(error)}`);
			}
		}
		let owner: string | null = null;
		try {
			owner = await workspaceOwner(repository.store, path);
		} catch (error) {
			errors.push(errorText(error));
		}
		workspaces.push({
			id: path,
			name: record?.name ?? (workspaces.length === 0 ? "Local checkout" : basename(path)),
			path,
			branch,
			head,
			main: workspaces.length === 0,
			current: path === root,
			locked: fields.some((field) => field === "locked" || field.startsWith("locked ")),
			missing,
			changes,
			owner,
			record,
			errors,
		});
	}
	const main = workspaces.find((workspace) => workspace.main);
	if (!main) throw new Error("No non-bare Git worktree found.");
	repository.folder = join(homedir(), "worktrees", `${basename(main.path)}-${key.slice(0, 8)}`);
	return { repository, workspaces };
}

export async function validateWorkspace(git: GitRunner, repository: Repository, workspace: Workspace): Promise<void> {
	if (workspace.missing) throw new Error(`Workspace is missing: ${workspace.path}. Restore it before opening.`);
	const root = await realpath(await git.run(["rev-parse", "--show-toplevel"], { cwd: workspace.path }));
	const common = await realpath(
		await git.run(["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: workspace.path }),
	);
	if (root !== workspace.path || common !== repository.commonDir) {
		throw new Error(`Workspace Git identity changed: ${workspace.path}.`);
	}
}

export async function createWorkspace(
	git: GitRunner,
	repository: Repository,
	name: string,
	baseCommit: string,
): Promise<WorkspaceRecord> {
	const branch = `feature/${name}`;
	const path = join(repository.folder, name);
	await mkdir(repository.folder, { recursive: true });
	await git.run(["worktree", "add", "-b", branch, path, baseCommit], { timeout: 120_000 });
	const record = { name, path: await realpath(path), branch: `refs/heads/${branch}`, baseCommit, sessionPath: null };
	try {
		await saveWorkspaceRecord(repository, record);
	} catch (error) {
		throw new Error(
			`Created ${record.path} on ${branch}, but could not save its metadata. The workspace remains available through /worktree.`,
			{ cause: error },
		);
	}
	return record;
}

export async function inspectRemoval(
	git: GitRunner,
	repository: Repository,
	workspace: Workspace,
): Promise<{ ignored: number; uniqueCommits: number; signature: string }> {
	if (workspace.current || workspace.main)
		throw new Error("Switch to another workspace before removing this checkout.");
	if (!workspace.record) throw new Error("Tau only removes workspaces it created.");
	if (workspace.locked) throw new Error("This worktree is locked. Unlock it yourself before removal.");
	if (workspace.errors.length) throw new Error(workspace.errors.join("\n"));
	await validateWorkspace(git, repository, workspace);
	const branch = await git.run(["symbolic-ref", "-q", "HEAD"], { cwd: workspace.path, optional: true });
	if (branch !== workspace.record.branch)
		throw new Error("This workspace changed branches. Restore its original branch before removal.");
	const status = await git.run(["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd: workspace.path });
	if (status)
		throw new Error("This workspace has unfinished changes or untracked files. Commit or move them before removal.");
	const ignored = await git.run(["ls-files", "--others", "--ignored", "--exclude-standard", "-z"], {
		cwd: workspace.path,
	});
	const refs = (await git.run(["for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes"]))
		.split("\n")
		.filter((ref) => ref && ref !== branch);
	const head = await git.run(["rev-parse", "HEAD"], { cwd: workspace.path });
	const uniqueCommits = Number(await git.run(["rev-list", "--count", head, "--not", ...refs]));
	return {
		ignored: ignored.split("\0").filter(Boolean).length,
		uniqueCommits,
		signature: createHash("sha256").update(`${head}\0${branch}\0${status}\0${ignored}`).digest("hex"),
	};
}

export async function removeWorkspace(git: GitRunner, repository: Repository, workspace: Workspace): Promise<void> {
	await git.run(["worktree", "remove", workspace.path], { timeout: 120_000 });
	await unlink(`${workspaceStorage(repository.store, workspace.path)}.json`);
	await rm(`${workspaceStorage(repository.store, workspace.path)}.sessions`, { recursive: true, force: true });
}

export async function cleanupMissingWorkspace(
	git: GitRunner,
	repository: Repository,
	workspace: Workspace,
): Promise<void> {
	const discovered = await discoverWorkspaces(git);
	if (discovered.repository.commonDir !== repository.commonDir)
		throw new Error("Repository identity changed. Cleanup cancelled.");
	const current = discovered.workspaces.find((item) => item.path === workspace.path);
	if (!current || !current.missing || current.main || current.current)
		throw new Error("Registration changed or the folder is no longer missing. Review it again with /worktree.");
	if (current.branch !== workspace.branch || current.head !== workspace.head)
		throw new Error("Registration changed during confirmation. Review it again with /worktree.");
	if (current.locked) throw new Error("This worktree is locked. Unlock it yourself before cleanup.");
	// lstat also rejects a dangling symlink: cleanup must not delete an existing filesystem entry.
	try {
		await lstat(current.path);
		throw new Error("The workspace folder exists. Cleanup cancelled.");
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
	}
	await git.run(["worktree", "remove", current.path]);
	await rm(`${workspaceStorage(repository.store, current.path)}.json`, { force: true });
	await rm(`${workspaceStorage(repository.store, current.path)}.sessions`, { recursive: true, force: true });
}
