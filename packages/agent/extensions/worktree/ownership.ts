import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { readJsonStatus, writeJsonObject } from "../../shared/settings/json.ts";

interface Owner {
	host: string;
	pid: number;
	token: string;
}

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

export async function workspaceOwner(store: string, path: string): Promise<string | null> {
	const owner = await readOwner(`${workspaceStorage(store, path)}.owner.json`);
	if (!owner || !ownerIsAlive(owner)) return null;
	return `${owner.host}, process ${owner.pid}`;
}

// All owner changes use the same short-lived exclusive claim, including stale-owner recovery.
// The claim file is created complete (written to a temp file, then hard-linked into place), so it
// always names its holder. A claim whose holder process has died is removed and retaken.
async function withOwnershipClaim<T>(storage: string, action: () => Promise<T>): Promise<T> {
	const path = `${storage}.claim`;
	const temp = `${path}.${randomUUID()}.tmp`;
	await writeJsonObject(temp, { host: hostname(), pid: process.pid, token: randomUUID() });
	try {
		for (;;) {
			try {
				await link(temp, path);
				break;
			} catch (error) {
				if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
				const holder = await readOwner(path);
				if (holder && ownerIsAlive(holder)) {
					throw new Error("Workspace ownership is being updated by another Tau process. Retry in a moment.");
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
		const owner = await readOwner(ownerPath);
		if (owner && ownerIsAlive(owner)) {
			throw new Error(
				`Workspace is already in use on ${owner.host} by process ${owner.pid}. Open another workspace instead.`,
			);
		}
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
