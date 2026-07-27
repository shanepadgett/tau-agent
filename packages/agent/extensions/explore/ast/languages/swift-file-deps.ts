import { basename, join, resolve } from "node:path";
import type { FileDepResolver } from "../adapter.ts";
import { collectFilesWithExtensions, externalId, internalPaths, isWithin } from "./file-dep-util.ts";

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

export const resolveSwiftFileDep: FileDepResolver = async (_fromPath, specifier, host, signal) => {
	signal.throwIfAborted();
	const moduleName = specifier.trim().split(/\s+/u)[0] ?? "";
	if (moduleName.length === 0) return { kind: "unresolved" };

	// Skip obvious system modules when no local dir exists — still try local first.
	const dirs = await findModuleDirs(host, moduleName, signal);
	const files: string[] = [];
	for (const dir of dirs) {
		if (!isWithin(host.scopeRoot, dir)) continue;
		const found = await collectFilesWithExtensions(host, dir, [".swift"], signal, 500);
		for (const file of found) {
			// Don't treat the module root listing as importing itself only — include all.
			if (basename(file) === moduleName) continue;
			files.push(file);
		}
	}
	if (files.length === 0) return externalId(moduleName);
	return internalPaths(files);
};
