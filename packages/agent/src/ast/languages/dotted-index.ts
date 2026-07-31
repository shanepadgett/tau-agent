import { dirname, relative, resolve, sep } from "node:path";
import type { FileDepHost } from "../adapter.ts";
import { collectFilesWithExtensions, pickClosestPath, readTextFile } from "./file-dep-util.ts";

/**
 * Shared resolution index for dotted-namespace languages (C#, Java, Kotlin).
 *
 * Two lookups, both from one scan: a dotted type FQN → the file declaring it,
 * and a dotted package → the directory holding it. Path-stem suffixes cover
 * layouts where file name equals type name; declared-name keys cover the rest
 * (Kotlin files whose name differs from their types, C# multi-type files).
 */

/** One declared type or top-level member, with the dotted package it sits in. */
export type DeclaredName = { pkg: string; name: string };

/** What a language pulls out of a file head. */
export type HeadScan = { packages: string[]; names: DeclaredName[] };

export type DottedIndex = {
	/** slash key (path stems and `pkg/Name` FQNs) → files */
	bySuffix: Map<string, string[]>;
	/** package slash key → directories holding its files, plus that file count */
	byPackage: Map<string, { dirs: string[]; fileCount: number }>;
};

/** Enough of a file to carry its package/namespace and top-level declarations. */
const HEAD_CHARS = 12000;

function slashKey(dotted: string): string {
	return dotted.replace(/\./gu, "/");
}

function pushSuffix(map: Map<string, string[]>, key: string, file: string): void {
	if (key.length === 0) return;
	const list = map.get(key);
	if (list === undefined) map.set(key, [file]);
	else if (!list.includes(file)) list.push(file);
}

/** Index every slash-suffix of a stem path: a/b/c → a/b/c, b/c, c */
function indexPathSuffixes(map: Map<string, string[]>, file: string, stemRelPosix: string): void {
	const parts = stemRelPosix.split("/").filter((part) => part.length > 0);
	for (let i = 0; i < parts.length; i += 1) {
		pushSuffix(map, parts.slice(i).join("/"), file);
	}
}

function toPosixRel(scopeRoot: string, file: string): string | undefined {
	const rel = relative(resolve(scopeRoot), resolve(file));
	if (rel.startsWith(`..${sep}`) || rel === ".." || rel.length === 0) return undefined;
	return rel.split(sep).join("/");
}

export async function buildDottedIndex(
	host: FileDepHost,
	memoPrefix: string,
	extensions: readonly string[],
	scanHead: (head: string) => HeadScan,
	signal: AbortSignal,
): Promise<DottedIndex> {
	const key = `${memoPrefix}:${host.scopeRoot}`;
	const cached = host.memo.get(key);
	if (cached !== undefined) return cached as DottedIndex;

	const bySuffix = new Map<string, string[]>();
	const byPackage = new Map<string, { dirs: string[]; fileCount: number }>();
	const files = await collectFilesWithExtensions(host, host.scopeRoot, extensions, signal);

	for (const file of files) {
		signal.throwIfAborted();
		const rel = toPosixRel(host.scopeRoot, file);
		if (rel === undefined) continue;
		const dot = rel.lastIndexOf(".");
		indexPathSuffixes(bySuffix, file, dot >= 0 ? rel.slice(0, dot) : rel);

		const text = await readTextFile(file);
		if (text === undefined) continue;
		const scan = scanHead(text.slice(0, HEAD_CHARS));
		const packages = new Set(scan.packages);
		for (const declared of scan.names) {
			if (declared.pkg.length === 0 || declared.name.length === 0) continue;
			packages.add(declared.pkg);
			pushSuffix(bySuffix, `${slashKey(declared.pkg)}/${declared.name}`, file);
		}
		const dir = dirname(file);
		for (const pkg of packages) {
			if (pkg.length === 0) continue;
			const entry = byPackage.get(slashKey(pkg));
			if (entry === undefined) byPackage.set(slashKey(pkg), { dirs: [dir], fileCount: 1 });
			else {
				if (!entry.dirs.includes(dir)) entry.dirs.push(dir);
				entry.fileCount += 1;
			}
		}
	}

	for (const [, list] of bySuffix) list.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
	const index: DottedIndex = { bySuffix, byPackage };
	host.memo.set(key, index);
	return index;
}

/** Dotted type FQN → declaring file, with a nested-type fallback to the outer type. */
export function resolveDottedFile(index: DottedIndex, fromPath: string, dotted: string): string | undefined {
	const key = slashKey(dotted);
	const hit = pickClosestPath(index.bySuffix.get(key) ?? [], fromPath);
	if (hit !== undefined) return hit;

	// Nested type: Foo.Bar.Inner → try the Foo.Bar file.
	const slash = key.lastIndexOf("/");
	if (slash <= 0) return undefined;
	return pickClosestPath(index.bySuffix.get(key.slice(0, slash)) ?? [], fromPath);
}

/**
 * Dotted package → its directory. The importer's own directory is not an edge:
 * same-directory files are visible without an import.
 */
export function resolveDottedPackage(
	index: DottedIndex,
	fromPath: string,
	dotted: string,
): { dir: string; fileCount: number } | undefined {
	const entry = index.byPackage.get(slashKey(dotted));
	if (entry === undefined) return undefined;
	const dir = pickClosestPath(entry.dirs, fromPath);
	if (dir === undefined) return undefined;
	if (resolve(dir) === resolve(dirname(fromPath))) return undefined;
	return { dir, fileCount: entry.fileCount };
}
