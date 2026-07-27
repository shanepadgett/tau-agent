import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { FileDepHost, FileDepResolution } from "../adapter.ts";

export function isWithin(parent: string, child: string): boolean {
	const rel = relative(resolve(parent), resolve(child));
	return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

export function internalPaths(paths: readonly string[]): FileDepResolution {
	const unique = [...new Set(paths.map((path) => resolve(path)))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
	if (unique.length === 0) return { kind: "unresolved" };
	return { kind: "internal", paths: unique };
}

export function externalId(id: string): FileDepResolution {
	return { kind: "external", id };
}

export async function firstExistingFile(host: FileDepHost, candidates: readonly string[]): Promise<string | undefined> {
	for (const candidate of candidates) {
		if (await host.isFile(candidate)) return resolve(candidate);
	}
	return undefined;
}

/** Walk ancestors from startDir up to and including stopDir. */
async function* walkAncestors(startDir: string, stopDir: string): AsyncGenerator<string> {
	let dir = resolve(startDir);
	const stop = resolve(stopDir);
	for (;;) {
		yield dir;
		if (dir === stop) return;
		const parent = dirname(dir);
		if (parent === dir) return;
		if (!isWithin(stop, parent) && parent !== stop) return;
		dir = parent;
	}
}

export async function findAncestorFile(
	host: FileDepHost,
	startDir: string,
	stopDir: string,
	fileName: string,
): Promise<string | undefined> {
	for await (const dir of walkAncestors(startDir, stopDir)) {
		const candidate = join(dir, fileName);
		if (await host.isFile(candidate)) return candidate;
	}
	return undefined;
}

export async function readTextFile(path: string): Promise<string | undefined> {
	try {
		return await readFile(path, "utf8");
	} catch {
		return undefined;
	}
}

/** Recursive file gather under root with extension filter; stays in scope via host.scopeRoot. */
export async function collectFilesWithExtensions(
	host: FileDepHost,
	root: string,
	extensions: readonly string[],
	signal: AbortSignal,
	maxFiles = 5000,
): Promise<string[]> {
	const extSet = new Set(extensions.map((ext) => ext.toLowerCase()));
	const out: string[] = [];
	const stack = [resolve(root)];
	while (stack.length > 0) {
		signal.throwIfAborted();
		if (out.length >= maxFiles) break;
		const dir = stack.pop();
		if (dir === undefined) break;
		if (!isWithin(host.scopeRoot, dir) && dir !== resolve(host.scopeRoot)) continue;
		const names = await host.readDir(dir);
		for (const name of names) {
			if (name === "." || name === ".." || name === "node_modules" || name === "target" || name === "dist") {
				continue;
			}
			if (name.startsWith(".")) continue;
			const full = join(dir, name);
			if (await host.isFile(full)) {
				const dot = name.lastIndexOf(".");
				const ext = dot >= 0 ? name.slice(dot).toLowerCase() : "";
				if (extSet.has(ext) && host.ownsPath(full)) out.push(full);
			} else if (await host.pathExists(full)) {
				stack.push(full);
			}
		}
	}
	return out;
}

export function packageNameFromBareSpecifier(specifier: string): string {
	if (specifier.startsWith("@")) {
		const parts = specifier.split("/");
		return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : specifier;
	}
	const slash = specifier.indexOf("/");
	return slash === -1 ? specifier : specifier.slice(0, slash);
}
