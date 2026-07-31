import { dirname, join, relative, resolve } from "node:path";
import type { FileDepResolver } from "../adapter.ts";
import { externalId, findAncestorFile, internalPaths, isWithin, readTextFile } from "./file-dep-util.ts";

type GoModInfo = {
	modulePath: string;
	moduleRoot: string;
	/** replace old => new local dir (absolute) */
	replaces: Map<string, string>;
};

function parseGoMod(text: string, moduleRoot: string): GoModInfo | undefined {
	let modulePath: string | undefined;
	const replaces = new Map<string, string>();
	const lines = text.split(/\r?\n/);
	let inReplaceBlock = false;
	for (const raw of lines) {
		const line = raw.replace(/\/\/.*$/, "").trim();
		if (line.length === 0) continue;
		if (inReplaceBlock) {
			if (line === ")") {
				inReplaceBlock = false;
				continue;
			}
			parseReplaceLine(line, moduleRoot, replaces);
			continue;
		}
		if (line.startsWith("module ")) {
			modulePath = line.slice("module ".length).trim();
			continue;
		}
		if (line.startsWith("replace ")) {
			const rest = line.slice("replace ".length).trim();
			if (rest === "(") {
				inReplaceBlock = true;
				continue;
			}
			parseReplaceLine(rest, moduleRoot, replaces);
		}
	}
	if (modulePath === undefined || modulePath.length === 0) return undefined;
	return { modulePath, moduleRoot, replaces };
}

function parseReplaceLine(line: string, moduleRoot: string, replaces: Map<string, string>): void {
	// old [version] => new [version]
	const parts = line.split(/\s+/);
	const arrow = parts.indexOf("=>");
	if (arrow <= 0 || arrow >= parts.length - 1) return;
	const oldPath = parts[0];
	const newPath = parts[arrow + 1];
	if (oldPath === undefined || newPath === undefined) return;
	if (newPath.startsWith("./") || newPath.startsWith("../") || newPath.startsWith("/")) {
		replaces.set(oldPath, resolve(moduleRoot, newPath));
	}
}

async function loadGoMod(host: Parameters<FileDepResolver>[2], fromPath: string): Promise<GoModInfo | undefined> {
	const key = `go-mod:${host.scopeRoot}`;
	const cached = host.memo.get(key);
	if (cached !== undefined) return cached as GoModInfo | undefined;

	const goModPath = await findAncestorFile(host, dirname(fromPath), host.scopeRoot, "go.mod");
	if (goModPath === undefined) {
		host.memo.set(key, undefined);
		return undefined;
	}
	const text = await readTextFile(goModPath);
	if (text === undefined) {
		host.memo.set(key, undefined);
		return undefined;
	}
	const info = parseGoMod(text, dirname(goModPath));
	host.memo.set(key, info);
	return info;
}

async function listPackageGoFiles(host: Parameters<FileDepResolver>[2], dir: string): Promise<string[]> {
	const names = await host.readDir(dir);
	const out: string[] = [];
	for (const name of names) {
		if (!name.endsWith(".go")) continue;
		if (name.endsWith("_test.go")) continue;
		const full = join(dir, name);
		if ((await host.isFile(full)) && host.ownsPath(full)) out.push(full);
	}
	return out;
}

function firstPathElement(specifier: string): string {
	const slash = specifier.indexOf("/");
	return slash === -1 ? specifier : specifier.slice(0, slash);
}

/**
 * Build constraints are not evaluated: a package resolves to every `.go` file in
 * its directory, so mutually exclusive `//go:build` variants all appear. Every
 * branch is reported on purpose — a per-configuration graph would need a build
 * context this layer does not have.
 */
export const resolveGoFileDep: FileDepResolver = async (fromPath, specifier, host, signal) => {
	signal.throwIfAborted();
	const trimmed = specifier.trim().replace(/^"+|"+$/g, "");
	if (trimmed.length === 0) return { kind: "unresolved" };

	if (trimmed.startsWith("./") || trimmed.startsWith("../")) {
		const dir = resolve(dirname(fromPath), trimmed);
		const files = await listPackageGoFiles(host, dir);
		return internalPaths(files.filter((path) => isWithin(host.scopeRoot, path)));
	}

	// Stdlib: no dot in first path element.
	if (!firstPathElement(trimmed).includes(".")) {
		return externalId(trimmed);
	}

	const mod = await loadGoMod(host, fromPath);
	if (mod === undefined) return externalId(trimmed);

	// replace takes precedence
	for (const [oldPath, newDir] of mod.replaces) {
		if (trimmed === oldPath || trimmed.startsWith(`${oldPath}/`)) {
			const rest = trimmed === oldPath ? "" : trimmed.slice(oldPath.length + 1);
			const dir = rest.length === 0 ? newDir : join(newDir, ...rest.split("/"));
			if (!isWithin(host.scopeRoot, dir) && dir !== host.scopeRoot) return externalId(trimmed);
			const files = await listPackageGoFiles(host, dir);
			return internalPaths(files);
		}
	}

	if (trimmed === mod.modulePath || trimmed.startsWith(`${mod.modulePath}/`)) {
		const rest = trimmed === mod.modulePath ? "" : trimmed.slice(mod.modulePath.length + 1);
		const dir =
			rest.length === 0 ? mod.moduleRoot : join(mod.moduleRoot, ...rest.split("/").filter((p) => p.length > 0));
		// Keep module-root resolves even when module root is the scope edge.
		if (!isWithin(host.scopeRoot, dir) && relative(host.scopeRoot, dir) !== "") {
			// Still allow if dir is under module root which may equal scope.
			if (!isWithin(mod.moduleRoot, dir)) return externalId(trimmed);
		}
		const files = await listPackageGoFiles(host, dir);
		return internalPaths(files.filter((path) => isWithin(host.scopeRoot, path) || isWithin(mod.moduleRoot, path)));
	}

	return externalId(trimmed);
};
