import { spawnSync } from "node:child_process";
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

export function formatRuntimeContextMessage(displayDate: string, rootSnapshot: readonly string[] | undefined): string {
	const blocks = [`Current local date: ${displayDate}`];
	if (rootSnapshot?.length) {
		blocks.push(`Root directory snapshot (depth 2):\n${rootSnapshot.map((path) => `- ${path}`).join("\n")}`);
	}
	return blocks.join("\n");
}

function visibleRootEntries(root: string): SnapshotEntry[] {
	const rootEntries = listSnapshotEntries(root, ".");
	const ignoredRootPaths = gitIgnoredPaths(
		root,
		rootEntries.map((entry) => entry.path),
	);
	return rootEntries.filter(
		(entry) => !isAlwaysHiddenFromSnapshot(entry.dirent.name) && !ignoredRootPaths.has(entry.path),
	);
}

function childEntriesByParent(
	root: string,
	roots: readonly SnapshotEntry[],
): {
	byParent: Map<string, SnapshotEntry[]>;
	ignoredChildPaths: Set<string>;
} {
	const byParent = new Map<string, SnapshotEntry[]>();
	const childPaths: string[] = [];
	for (const entry of roots) {
		if (!entry.dirent.isDirectory()) continue;
		const childEntries = listSnapshotEntries(root, entry.path).filter(
			(childEntry) => !isAlwaysHiddenFromSnapshot(childEntry.dirent.name),
		);
		byParent.set(entry.path, childEntries);
		childPaths.push(...childEntries.map((childEntry) => childEntry.path));
	}
	return { byParent, ignoredChildPaths: gitIgnoredPaths(root, childPaths) };
}

function collectSnapshotPaths(
	roots: readonly SnapshotEntry[],
	byParent: Map<string, SnapshotEntry[]>,
	ignoredChildPaths: ReadonlySet<string>,
): string[] {
	const paths: string[] = [];
	for (const entry of roots) {
		pushSnapshotPath(paths, entry);
		if (paths.length >= ROOT_SNAPSHOT_MAX_PATHS) break;
		for (const childEntry of byParent.get(entry.path) ?? []) {
			if (ignoredChildPaths.has(childEntry.path)) continue;
			pushSnapshotPath(paths, childEntry);
			if (paths.length >= ROOT_SNAPSHOT_MAX_PATHS) break;
		}
	}
	return paths;
}

function listRootSnapshot(cwd: string): string[] {
	const root = resolve(cwd);
	const roots = visibleRootEntries(root);
	const children = childEntriesByParent(root, roots);
	const paths = collectSnapshotPaths(roots, children.byParent, children.ignoredChildPaths);
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
