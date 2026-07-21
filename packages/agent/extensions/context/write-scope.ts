import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { GitRunner } from "../../shared/git.ts";

export type OutsidePathSnapshot = Map<string, Buffer | null>;

export function isContextCatalogPath(path: string): boolean {
	const normalized = path.replaceAll("\\", "/");
	return normalized === ".pi/contexts" || normalized.startsWith(".pi/contexts/");
}

export async function snapshotOutsideContext(git: GitRunner, root: string): Promise<OutsidePathSnapshot> {
	const snapshot: OutsidePathSnapshot = new Map();
	for (const path of await listDirtyPaths(git, root)) {
		if (isContextCatalogPath(path)) continue;
		snapshot.set(path, await readPathContent(root, path));
	}
	return snapshot;
}

export async function restoreOutsideContextMutations(
	git: GitRunner,
	root: string,
	before: OutsidePathSnapshot,
): Promise<string[]> {
	const afterDirty = await listDirtyPaths(git, root);
	const candidates = new Set([...before.keys(), ...afterDirty.filter((path) => !isContextCatalogPath(path))]);
	const violations: string[] = [];
	for (const path of [...candidates].sort((left, right) => left.localeCompare(right))) {
		if (isContextCatalogPath(path)) continue;
		const prior = before.has(path) ? before.get(path) : undefined;
		const current = await readPathContent(root, path);
		if (sameContent(prior, current)) continue;
		violations.push(path);
		await restorePath(git, root, path, prior);
	}
	return violations;
}

async function listDirtyPaths(git: GitRunner, root: string): Promise<string[]> {
	const raw = await git.run(["status", "--porcelain=v2", "-z", "--untracked-files=all"], { cwd: root });
	const parts = raw.split("\0").filter(Boolean);
	const paths = new Set<string>();
	for (let index = 0; index < parts.length; index++) {
		const record = parts[index];
		if (!record) continue;
		if (record[0] === "?") {
			paths.add(record.slice(2).replaceAll("\\", "/"));
			continue;
		}
		const fields = record.split(" ");
		if (record[0] === "1") {
			const path = fields.slice(8).join(" ").replaceAll("\\", "/");
			if (path) paths.add(path);
		} else if (record[0] === "2") {
			const path = fields.slice(9).join(" ").replaceAll("\\", "/");
			const oldPath = parts[index + 1]?.replaceAll("\\", "/");
			if (path) paths.add(path);
			if (oldPath) paths.add(oldPath);
			index++;
		} else if (record[0] === "u") {
			const path = fields.slice(10).join(" ").replaceAll("\\", "/");
			if (path) paths.add(path);
		}
	}
	return [...paths].sort((left, right) => left.localeCompare(right));
}

async function readPathContent(root: string, path: string): Promise<Buffer | null> {
	try {
		return await readFile(join(root, path));
	} catch {
		return null;
	}
}

function sameContent(left: Buffer | null | undefined, right: Buffer | null): boolean {
	if (left === undefined) return false;
	if (left === null || right === null) return left === right;
	return left.equals(right);
}

async function restorePath(
	git: GitRunner,
	root: string,
	path: string,
	prior: Buffer | null | undefined,
): Promise<void> {
	const absolute = join(root, path);
	if (prior === undefined) {
		// Was clean before the run: restore tracked paths from HEAD, delete new untracked paths.
		const tracked = await git.run(["ls-files", "--error-unmatch", "--", path], {
			cwd: root,
			optional: true,
		});
		if (tracked) {
			await git.run(["restore", "--worktree", "--source=HEAD", "--", path], { cwd: root });
			return;
		}
		await unlink(absolute).catch(() => {});
		return;
	}
	if (prior === null) {
		await unlink(absolute).catch(() => {});
		return;
	}
	await mkdir(dirname(absolute), { recursive: true });
	await writeFile(absolute, prior);
}
