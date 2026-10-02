import { createHash } from "node:crypto";
import { mkdir, realpath, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { GitRunner } from "../../shared/git.ts";
import { readJsonStatus, writeJsonObject } from "../../shared/settings/json.ts";
import { workspaceOwner, workspaceStorage } from "./ownership.ts";

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
		try {
			path = await realpath(path);
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
			missing = true;
		}
		const branch = fields.find((field) => field.startsWith("branch "))?.slice(7) ?? null;
		const head = fields.find((field) => field.startsWith("HEAD "))?.slice(5) ?? "";
		const record = await loadWorkspaceRecord(repository, path);
		let changes: number | null = null;
		if (!missing) {
			const status = await git.run(["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd: path });
			const entries = status.split("\0").filter(Boolean);
			changes = 0;
			for (let index = 0; index < entries.length; index++) {
				changes++;
				if (/^[RC]|^.[RC]/.test(entries[index] ?? "")) index++;
			}
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
			owner: await workspaceOwner(repository.store, path),
			record,
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
}
