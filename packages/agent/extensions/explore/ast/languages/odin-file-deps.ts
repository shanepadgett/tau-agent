import { dirname, join, resolve } from "node:path";
import type { FileDepHost, FileDepResolver } from "../adapter.ts";
import { externalId, firstExistingFile, internalPaths, isWithin } from "./file-dep-util.ts";

/** `collection:pkg/path` — Odin collection import. */
const COLLECTION_SPEC = /^([A-Za-z_][A-Za-z0-9_]*):(.+)$/u;

async function isDir(host: FileDepHost, path: string): Promise<boolean> {
	if (!(await host.pathExists(path))) return false;
	if (await host.isFile(path)) return false;
	return true;
}

/** Direct `.odin` package files in a directory (not nested packages). */
async function listOdinPackageFiles(host: FileDepHost, dir: string): Promise<string[]> {
	if (!(await isDir(host, dir))) return [];
	const names = await host.readDir(dir);
	const out: string[] = [];
	for (const name of names) {
		if (!name.endsWith(".odin")) continue;
		const full = join(dir, name);
		if ((await host.isFile(full)) && host.ownsPath(full)) out.push(full);
	}
	return out;
}

/**
 * Odin root under scope: directory that has both `core` and `base` collections.
 * Also accepts ODIN_ROOT when that path sits inside the scope.
 */
async function findOdinRoot(host: FileDepHost, fromPath: string): Promise<string | undefined> {
	const key = `odin-root:${host.scopeRoot}`;
	if (host.memo.has(key)) return host.memo.get(key) as string | undefined;

	const envRoot = process.env.ODIN_ROOT?.trim();
	if (envRoot !== undefined && envRoot.length > 0) {
		const absolute = resolve(envRoot);
		if (isWithin(host.scopeRoot, absolute) || absolute === resolve(host.scopeRoot)) {
			if ((await isDir(host, join(absolute, "core"))) && (await isDir(host, join(absolute, "base")))) {
				host.memo.set(key, absolute);
				return absolute;
			}
		}
	}

	let dir = resolve(dirname(fromPath));
	const stop = resolve(host.scopeRoot);
	for (;;) {
		if (isWithin(stop, dir) || dir === stop) {
			const core = join(dir, "core");
			const base = join(dir, "base");
			if ((await isDir(host, core)) && (await isDir(host, base))) {
				host.memo.set(key, dir);
				return dir;
			}
		}
		if (dir === stop) break;
		const parent = dirname(dir);
		if (parent === dir) break;
		if (!isWithin(stop, parent) && parent !== stop) break;
		dir = parent;
	}

	// Scope itself may be the Odin tree root even when fromPath walk missed.
	const scopeCore = join(stop, "core");
	const scopeBase = join(stop, "base");
	if ((await isDir(host, scopeCore)) && (await isDir(host, scopeBase))) {
		host.memo.set(key, stop);
		return stop;
	}

	host.memo.set(key, undefined);
	return undefined;
}

/**
 * Candidate roots for a named collection, nearest-first.
 * Project `vendor`/`shared` beside sources beat the compiler tree when both exist.
 */
async function collectionRoots(host: FileDepHost, collection: string, fromPath: string): Promise<string[]> {
	const key = `odin-collection:${host.scopeRoot}:${collection}`;
	const cached = host.memo.get(key);
	if (cached !== undefined) return cached as string[];

	const found: string[] = [];
	const seen = new Set<string>();
	const add = async (candidate: string) => {
		const absolute = resolve(candidate);
		if (seen.has(absolute)) return;
		if (!isWithin(host.scopeRoot, absolute) && absolute !== resolve(host.scopeRoot)) return;
		if (!(await isDir(host, absolute))) return;
		seen.add(absolute);
		found.push(absolute);
	};

	// Ancestors from the importing file up to scope (project-local collections).
	let dir = resolve(dirname(fromPath));
	const stop = resolve(host.scopeRoot);
	for (;;) {
		await add(join(dir, collection));
		if (dir === stop) break;
		const parent = dirname(dir);
		if (parent === dir) break;
		if (!isWithin(stop, parent) && parent !== stop) break;
		dir = parent;
	}

	await add(join(stop, collection));

	const odinRoot = await findOdinRoot(host, fromPath);
	if (odinRoot !== undefined) await add(join(odinRoot, collection));

	host.memo.set(key, found);
	return found;
}

async function resolveCollectionImport(
	host: FileDepHost,
	collection: string,
	pkgPath: string,
	fromPath: string,
	signal: AbortSignal,
): Promise<ReturnType<typeof internalPaths> | ReturnType<typeof externalId>> {
	const id = `${collection}:${pkgPath}`;
	const segments = pkgPath.split(/[/\\]/u).filter((part) => part.length > 0 && part !== "." && part !== "..");
	if (segments.length === 0) return externalId(id);

	const roots = await collectionRoots(host, collection, fromPath);
	for (const root of roots) {
		signal.throwIfAborted();
		const dir = join(root, ...segments);
		if (!isWithin(host.scopeRoot, dir) && dir !== resolve(host.scopeRoot)) continue;
		const files = await listOdinPackageFiles(host, dir);
		if (files.length > 0) return internalPaths(files);
	}
	return externalId(id);
}

async function resolveRelativeImport(
	host: FileDepHost,
	fromPath: string,
	trimmed: string,
): Promise<ReturnType<typeof internalPaths> | { kind: "unresolved" }> {
	const absolute = resolve(dirname(fromPath), trimmed);
	const candidates = [absolute, `${absolute}.odin`, join(absolute, "main.odin")];
	const file = await firstExistingFile(host, candidates);
	if (file !== undefined && isWithin(host.scopeRoot, file)) return internalPaths([file]);

	const files = (await listOdinPackageFiles(host, absolute)).filter((path) => isWithin(host.scopeRoot, path));
	if (files.length > 0) return internalPaths(files);
	return { kind: "unresolved" };
}

export const resolveOdinFileDep: FileDepResolver = async (fromPath, specifier, host, signal) => {
	signal.throwIfAborted();
	const trimmed = specifier.trim().replace(/^"+|"+$/gu, "");
	if (trimmed.length === 0) return { kind: "unresolved" };

	const collection = COLLECTION_SPEC.exec(trimmed);
	if (collection !== null) {
		const name = collection[1];
		const pkg = collection[2];
		if (name === undefined || pkg === undefined) return { kind: "unresolved" };
		return resolveCollectionImport(host, name, pkg, fromPath, signal);
	}

	// Relative / path-like package path
	if (trimmed.startsWith("./") || trimmed.startsWith("../") || trimmed.includes("/") || trimmed.includes("\\")) {
		return resolveRelativeImport(host, fromPath, trimmed);
	}

	// Bare name with no collection — cannot resolve without collection config.
	return externalId(trimmed);
};
