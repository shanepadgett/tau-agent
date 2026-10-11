import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { cp, lstat, mkdir, readFile, realpath, rm, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
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

export async function discoverRepository(git: GitRunner): Promise<{ repository: Repository; registrations: string[] }> {
	const root = await realpath(await git.run(["rev-parse", "--show-toplevel"]));
	const commonDir = await realpath(await git.run(["rev-parse", "--path-format=absolute", "--git-common-dir"]));
	const key = createHash("sha256").update(commonDir).digest("hex");
	const output = await git.run(["worktree", "list", "--porcelain", "-z"]);
	const registrations = output.split("\0\0").filter((block) => block && !block.split("\0").includes("bare"));
	const main = registrations[0]
		?.split("\0")
		.find((field) => field.startsWith("worktree "))
		?.slice(9);
	if (!main) throw new Error("No non-bare Git worktree found.");
	const repository: Repository = {
		root,
		commonDir,
		store: join(getAgentDir(), "tau", "worktrees", key),
		folder: join(homedir(), "worktrees", `${basename(main)}-${key.slice(0, 8)}`),
	};
	return { repository, registrations };
}

export async function discoverWorkspaces(git: GitRunner): Promise<{ repository: Repository; workspaces: Workspace[] }> {
	const { repository, registrations } = await discoverRepository(git);
	const workspaces: Workspace[] = [];
	for (const block of registrations) {
		const fields = block.split("\0");
		const registeredPath = fields.find((field) => field.startsWith("worktree "))?.slice(9);
		if (!registeredPath) continue;
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
			name: record?.name ?? (workspaces.length === 0 ? "Main checkout" : basename(path)),
			path,
			branch,
			head,
			main: workspaces.length === 0,
			current: path === repository.root,
			locked: fields.some((field) => field === "locked" || field.startsWith("locked ")),
			missing,
			changes,
			owner,
			record,
			errors,
		});
	}
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
	signal: AbortSignal | undefined,
): Promise<WorkspaceRecord> {
	const baseCommit = await git.run(["rev-parse", "--verify", "HEAD^{commit}"], { cwd: repository.root });
	const sourceBranch = await git.run(["symbolic-ref", "--short", "-q", "HEAD"], {
		cwd: repository.root,
		optional: true,
	});
	const source = (sourceBranch || `detached-${baseCommit.slice(0, 7)}`)
		.replace(/^wt\//, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.slice(0, 40)
		.replace(/^-|-$/g, "");
	const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
	const name = `${source || "checkout"}-${stamp}-${randomUUID().slice(0, 6)}`;
	const branch = `wt/${name}`;
	signal?.throwIfAborted();
	await mkdir(repository.folder, { recursive: true });
	const path = join(await realpath(repository.folder), name);
	const destination = relative(repository.root, path);
	if (
		destination !== ".." &&
		!destination.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
		!isAbsolute(destination)
	)
		throw new Error("The worktree destination must be outside the source checkout.");
	const sourceIndex = await git.run(["rev-parse", "--path-format=absolute", "--git-path", "index"], {
		cwd: repository.root,
	});
	const index = await readIndex(sourceIndex);
	const sharedPath = await git.run(["rev-parse", "--path-format=absolute", "--shared-index-path"], {
		cwd: repository.root,
	});
	const sharedIndex = sharedPath ? await readFile(resolve(repository.root, sharedPath)) : null;
	signal?.throwIfAborted();
	// Start empty so tracked deletions, sparse checkouts, and untracked files are
	// copied exactly as they exist, rather than overlaid onto a clean checkout.
	await git.run(["worktree", "add", "--no-checkout", "-b", branch, path, baseCommit], {
		cwd: repository.root,
		timeout: 120_000,
	});
	try {
		await cp(repository.root, path, {
			recursive: true,
			mode: constants.COPYFILE_FICLONE,
			preserveTimestamps: true,
			verbatimSymlinks: true,
			filter: (sourcePath) => {
				signal?.throwIfAborted();
				if (sourcePath === join(repository.root, ".git")) return false;
				if (basename(sourcePath) === ".git")
					throw new Error(
						`Cannot safely copy nested Git metadata at ${sourcePath}. Nested repositories and initialized submodules must be handled separately.`,
					);
				return true;
			},
		});
		const currentIndex = await readIndex(sourceIndex);
		const currentHead = await git.run(["rev-parse", "HEAD"], { cwd: repository.root });
		if (
			currentHead !== baseCommit ||
			(index === null ? currentIndex !== null : currentIndex === null || !index.equals(currentIndex))
		)
			throw new Error(
				"The source HEAD or staging index changed while copying. Retry when other Git operations have finished.",
			);
		const targetIndex = await git.run(["rev-parse", "--path-format=absolute", "--git-path", "index"], { cwd: path });
		// Preserve the index bytes, including partial staging, conflict stages,
		// intent-to-add, and sparse/split-index extensions. Never hard-link them.
		if (sharedIndex) await writeFile(join(dirname(targetIndex), basename(sharedPath)), sharedIndex, { mode: 0o600 });
		if (index) await writeFile(targetIndex, index, { mode: 0o600 });
		signal?.throwIfAborted();
		const record = {
			name,
			path: await realpath(path),
			branch: `refs/heads/${branch}`,
			baseCommit,
			sessionPath: null,
		};
		await saveWorkspaceRecord(repository, record);
		return record;
	} catch (error) {
		throw new Error(
			`Could not finish copying ${path} on ${branch}: ${errorText(error)}. The source is unchanged. The incomplete worktree remains registered; inspect it with /wt list before using it.`,
			{ cause: error },
		);
	}
}

async function readIndex(path: string): Promise<Buffer | null> {
	try {
		return await readFile(path);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
		throw error;
	}
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
	const signature = createHash("sha256").update(`${head}\0${branch}\0${status}\0${ignored}`);
	for (const file of ignored.split("\0").filter(Boolean)) {
		const info = await lstat(join(workspace.path, file));
		signature.update(`\0${file}\0${info.mode}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`);
	}
	return {
		ignored: ignored.split("\0").filter(Boolean).length,
		uniqueCommits,
		signature: signature.digest("hex"),
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
		throw new Error("Registration changed or the folder is no longer missing. Review it again with /wt list.");
	if (current.branch !== workspace.branch || current.head !== workspace.head)
		throw new Error("Registration changed during confirmation. Review it again with /wt list.");
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
