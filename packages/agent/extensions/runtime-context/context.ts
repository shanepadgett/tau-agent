import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { type Dirent, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT_SNAPSHOT_MAX_PATHS = 300;

interface SnapshotEntry {
	dirent: Dirent;
	path: string;
}

export interface RuntimeContext {
	cwd: string;
	rootSnapshot: readonly string[];
}

export function freezeRuntimeContext(cwd: string): RuntimeContext {
	return { cwd: cwd.replace(/\\/g, "/"), rootSnapshot: listRootSnapshot(cwd) };
}

export function formatLocalDateKey(date: Date): string {
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

export function formatLocalDisplayDate(date: Date): string {
	const months = [
		"January",
		"February",
		"March",
		"April",
		"May",
		"June",
		"July",
		"August",
		"September",
		"October",
		"November",
		"December",
	];
	return `${date.getDate()} ${months[date.getMonth()]} ${date.getFullYear()}`;
}

export function fingerprintRuntimeSnapshot(context: RuntimeContext): string {
	return createHash("sha256")
		.update(JSON.stringify({ version: 1, cwd: context.cwd, paths: context.rootSnapshot }))
		.digest("hex");
}

export function formatRuntimeContextMessage(displayDate: string, rootSnapshot: readonly string[] | undefined): string {
	const blocks = [`Current local date: ${displayDate}`];
	if (rootSnapshot?.length) {
		blocks.push(`Root directory snapshot (depth 2):\n${rootSnapshot.map((path) => `- ${path}`).join("\n")}`);
	}
	return blocks.join("\n");
}

function listRootSnapshot(cwd: string): string[] {
	const root = resolve(cwd);
	const rootEntries = listSnapshotEntries(root, ".");
	const ignoredRootPaths = gitIgnoredPaths(
		root,
		rootEntries.map((entry) => entry.path),
	);
	const visibleRootEntries = rootEntries.filter(
		(entry) => !isAlwaysHiddenFromSnapshot(entry.dirent.name) && !ignoredRootPaths.has(entry.path),
	);
	const childEntriesByParent = new Map<string, SnapshotEntry[]>();
	const childPaths: string[] = [];

	for (const entry of visibleRootEntries) {
		if (!entry.dirent.isDirectory()) continue;
		const childEntries = listSnapshotEntries(root, entry.path).filter(
			(childEntry) => !isAlwaysHiddenFromSnapshot(childEntry.dirent.name),
		);
		childEntriesByParent.set(entry.path, childEntries);
		childPaths.push(...childEntries.map((childEntry) => childEntry.path));
	}

	const ignoredChildPaths = gitIgnoredPaths(root, childPaths);
	const paths: string[] = [];

	for (const entry of visibleRootEntries) {
		pushSnapshotPath(paths, entry);
		if (paths.length >= ROOT_SNAPSHOT_MAX_PATHS) break;

		for (const childEntry of childEntriesByParent.get(entry.path) ?? []) {
			if (ignoredChildPaths.has(childEntry.path)) continue;
			pushSnapshotPath(paths, childEntry);
			if (paths.length >= ROOT_SNAPSHOT_MAX_PATHS) break;
		}
	}

	return paths.length === ROOT_SNAPSHOT_MAX_PATHS ? [...paths, "..."] : paths;
}

function listSnapshotEntries(root: string, relativePath: string): SnapshotEntry[] {
	let entries: Dirent[];
	try {
		entries = readdirSync(join(root, relativePath), { withFileTypes: true });
	} catch {
		return [];
	}

	return entries
		.sort((left, right) => left.name.localeCompare(right.name))
		.map((dirent) => ({
			dirent,
			path: relativePath === "." ? dirent.name : `${relativePath}/${dirent.name}`,
		}));
}

function gitIgnoredPaths(root: string, paths: readonly string[]): Set<string> {
	if (paths.length === 0) return new Set();

	const result = spawnSync("git", ["check-ignore", "-z", "--stdin"], {
		cwd: root,
		encoding: "utf8",
		input: `${paths.join("\0")}\0`,
	});

	if (result.status === 0 || result.status === 1) {
		return new Set(result.stdout.split("\0").filter(Boolean));
	}
	return new Set(paths.filter((path) => path.split("/").includes("node_modules")));
}

function isAlwaysHiddenFromSnapshot(name: string): boolean {
	return name === ".git";
}

function pushSnapshotPath(paths: string[], entry: SnapshotEntry): void {
	if (paths.length >= ROOT_SNAPSHOT_MAX_PATHS) return;
	paths.push(entry.dirent.isDirectory() ? `${entry.path}/` : entry.path);
}
