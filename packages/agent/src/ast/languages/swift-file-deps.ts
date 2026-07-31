import { join, resolve, sep } from "node:path";
import type { FileDepResolver } from "../adapter.ts";
import {
	collectFilesWithExtensions,
	externalId,
	isWithin,
	packageDirectory,
	pickClosestPath,
} from "./file-dep-util.ts";

async function findModuleDirs(
	host: Parameters<FileDepResolver>[2],
	moduleName: string,
	signal: AbortSignal,
): Promise<string[]> {
	const key = `swift-mod:${host.scopeRoot}:${moduleName}`;
	const cached = host.memo.get(key);
	if (cached !== undefined) return cached as string[];

	const hits: string[] = [];
	const stack = [resolve(host.scopeRoot)];
	while (stack.length > 0) {
		signal.throwIfAborted();
		const dir = stack.pop();
		if (dir === undefined) break;
		const names = await host.readDir(dir);
		for (const name of names) {
			if (name === "." || name === ".." || name.startsWith(".") || name === "node_modules") continue;
			const full = join(dir, name);
			const isDir = !(await host.isFile(full)) && (await host.pathExists(full));
			if (!isDir) continue;
			// Sources/Module or directory named Module with swift files
			if (name === moduleName) hits.push(full);
			if ((name === "Sources" || name === "Source") && (await host.pathExists(join(full, moduleName)))) {
				hits.push(join(full, moduleName));
			}
			// Bound depth a bit via path length under scope
			if (full.split("/").length - host.scopeRoot.split("/").length < 8) stack.push(full);
		}
		if (hits.length >= 8) break;
	}
	host.memo.set(key, hits);
	return hits;
}

/**
 * `import SomeModule` names a module, not a file list: expanding it to every
 * file in the module directory made `deps` and `impact` unusable on real corpora.
 * One package edge for the module directory instead.
 */
export const resolveSwiftFileDep: FileDepResolver = async (fromPath, specifier, host, signal) => {
	signal.throwIfAborted();
	const moduleName = specifier.trim().split(/\s+/u)[0] ?? "";
	if (moduleName.length === 0) return { kind: "unresolved" };

	// Skip obvious system modules when no local dir exists — still try local first.
	const dirs = await findModuleDirs(host, moduleName, signal);
	const inScope = dirs.filter((dir) => isWithin(host.scopeRoot, dir));
	const dir = pickClosestPath(inScope, fromPath);
	if (dir === undefined) return externalId(moduleName);
	const files = await collectFilesWithExtensions(host, dir, [".swift"], signal, 500);
	// Package.swift is the manifest, not module source.
	const sources = files.filter((file) => !file.endsWith(`${sep}Package.swift`));
	if (sources.length === 0) return externalId(moduleName);
	return packageDirectory(moduleName, dir, sources.length);
};
