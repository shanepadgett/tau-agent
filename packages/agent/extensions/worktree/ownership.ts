import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, readdir, rmdir, stat, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import { basename, join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { readJsonStatus, writeJsonObject } from "../../shared/settings/json.ts";

interface Owner {
	host: string;
	pid: number;
	token: string;
}

const STALE_SESSION_MS = 24 * 60 * 60 * 1000;

export interface WorkspaceLease {
	valid(): Promise<boolean>;
	release(): Promise<void>;
}

export function workspaceStorage(store: string, path: string): string {
	return join(store, createHash("sha256").update(path).digest("hex"));
}

async function readOwner(path: string): Promise<Owner | null> {
	const status = await readJsonStatus(path);
	if (!status.exists) return null;
	if (!status.ok) throw new Error(`Cannot verify workspace ownership: ${status.error}`);
	const value = status.value;
	if (
		typeof value.host !== "string" ||
		!Number.isSafeInteger(value.pid) ||
		typeof value.pid !== "number" ||
		value.pid <= 0 ||
		typeof value.token !== "string"
	) {
		throw new Error(`Invalid workspace ownership record: ${path}.`);
	}
	return { host: value.host, pid: value.pid, token: value.token };
}

function ownerIsAlive(owner: Owner): boolean {
	if (owner.host !== hostname()) return true;
	try {
		process.kill(owner.pid, 0);
		return true;
	} catch (error) {
		return !(error instanceof Error && "code" in error && error.code === "ESRCH");
	}
}

async function workspaceSessions(storage: string): Promise<{ path: string; owner: Owner; alive: boolean }[]> {
	let files: string[];
	try {
		files = await readdir(`${storage}.sessions`);
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
		files = [];
	}
	const sessions: { path: string; owner: Owner; alive: boolean }[] = [];
	for (const file of files) {
		if (!file.endsWith(".json")) continue;
		const path = join(`${storage}.sessions`, file);
		const owner = await readOwner(path);
		if (!owner) continue;
		let alive = ownerIsAlive(owner);
		if (owner.host !== hostname()) {
			// Hostnames can change after a network switch. Only advisory session records
			// expire; exclusive removal leases and ownership claims do not.
			try {
				alive = Date.now() - (await stat(path)).mtimeMs < STALE_SESSION_MS;
			} catch (error) {
				if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
				continue;
			}
		}
		sessions.push({ path, owner, alive });
	}
	return sessions;
}

export async function workspaceOwner(store: string, path: string): Promise<string | null> {
	const storage = workspaceStorage(store, path);
	const owners: string[] = [];
	const owner = await readOwner(`${storage}.owner.json`);
	if (owner && ownerIsAlive(owner)) owners.push(`${owner.host}, process ${owner.pid}`);
	for (const session of await workspaceSessions(storage)) {
		if (session.alive) owners.push(`${session.owner.host}, process ${session.owner.pid}`);
	}
	return owners.length ? owners.join("; ") : null;
}

// All owner changes use the same short-lived exclusive claim, including stale-owner recovery.
// The claim file is created complete (written to a temp file, then hard-linked into place), so it
// always names its holder. A claim whose holder process has died is removed and retaken.
async function withOwnershipClaim<T>(storage: string, action: () => Promise<T>): Promise<T> {
	const path = `${storage}.claim`;
	const temp = `${path}.${randomUUID()}.tmp`;
	await writeJsonObject(temp, { host: hostname(), pid: process.pid, token: randomUUID() });
	try {
		let retries = 0;
		for (;;) {
			try {
				await link(temp, path);
				break;
			} catch (error) {
				if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
				const holder = await readOwner(path);
				if (holder && ownerIsAlive(holder)) {
					if (retries++ >= 20)
						throw new Error("Workspace ownership is being updated by another Tau process. Retry in a moment.");
					await setTimeout(25);
					continue;
				}
				if (holder) await unlink(path);
			}
		}
	} finally {
		await unlink(temp);
	}
	try {
		return await action();
	} finally {
		await unlink(path);
	}
}

export async function acquireWorkspace(store: string, path: string): Promise<WorkspaceLease> {
	await mkdir(store, { recursive: true, mode: 0o700 });
	const storage = workspaceStorage(store, path);
	const ownerPath = `${storage}.owner.json`;
	const token = randomUUID();
	await withOwnershipClaim(storage, async () => {
		const owner = await workspaceOwner(store, path);
		if (owner) throw new Error(`Workspace is in use by ${owner}. Close its Tau sessions before removing it.`);
		await writeJsonObject(ownerPath, { host: hostname(), pid: process.pid, token });
	});
	return {
		async valid() {
			return (await readOwner(ownerPath))?.token === token;
		},
		async release() {
			await withOwnershipClaim(storage, async () => {
				if ((await readOwner(ownerPath))?.token === token) await unlink(ownerPath);
			});
		},
	};
}

export async function registerWorkspaceSession(
	store: string,
	path: string,
): Promise<{ otherOwner: string | null; release(): Promise<void> }> {
	await mkdir(store, { recursive: true, mode: 0o700 });
	const storage = workspaceStorage(store, path);
	const directory = `${storage}.sessions`;
	const token = randomUUID();
	const sessionPath = join(directory, `${token}.json`);
	const otherOwner = await withOwnershipClaim(storage, async () => {
		const removal = await readOwner(`${storage}.owner.json`);
		if (removal && ownerIsAlive(removal)) throw new Error("Workspace removal is in progress. Retry in a moment.");
		for (const session of await workspaceSessions(storage)) {
			if (!session.alive) await unlink(session.path);
		}
		await mkdir(directory, { recursive: true, mode: 0o700 });
		// Atomic writes can leave incomplete temporary files after a crash. Restrict
		// cleanup to this workspace and allow a full day for concurrent writes.
		for (const [folder, prefix] of [
			[store, `${basename(storage)}.claim.`],
			[directory, ""],
		] as const) {
			for (const file of await readdir(folder)) {
				if (!file.startsWith(prefix) || !file.endsWith(".tmp")) continue;
				const temp = join(folder, file);
				try {
					if (Date.now() - (await stat(temp)).mtimeMs >= STALE_SESSION_MS) await unlink(temp);
				} catch (error) {
					if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
				}
			}
		}
		const owner = await workspaceOwner(store, path);
		await writeJsonObject(sessionPath, { host: hostname(), pid: process.pid, token });
		return owner;
	});
	return {
		otherOwner,
		async release() {
			await withOwnershipClaim(storage, async () => {
				if ((await readOwner(sessionPath))?.token === token) await unlink(sessionPath);
				try {
					await rmdir(directory);
				} catch (error) {
					if (
						!(
							error instanceof Error &&
							"code" in error &&
							(error.code === "ENOTEMPTY" || error.code === "ENOENT")
						)
					)
						throw error;
				}
			});
		},
	};
}
