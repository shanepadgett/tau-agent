import { basename, dirname, join, relative, sep } from "node:path";
import type { FileDepResolver } from "../adapter.ts";
import { externalId, findAncestorFile, firstExistingFile, internalPaths, isWithin } from "./file-dep-util.ts";

function splitRustPath(specifier: string): string[] {
	return specifier
		.replace(/\{[\s\S]*\}$/u, "") // drop use-group braces for v1 leading path
		.split("::")
		.map((part) => part.trim())
		.filter((part) => part.length > 0 && part !== "self");
}

async function moduleFileCandidates(dir: string, name: string): Promise<string[]> {
	return [join(dir, `${name}.rs`), join(dir, name, "mod.rs")];
}

async function resolveModuleChain(
	host: Parameters<FileDepResolver>[2],
	startDir: string,
	segments: readonly string[],
): Promise<string | undefined> {
	let dir = startDir;
	let lastFile: string | undefined;
	for (let i = 0; i < segments.length; i += 1) {
		const name = segments[i];
		if (name === undefined) break;
		const candidates = await moduleFileCandidates(dir, name);
		const file = await firstExistingFile(host, candidates);
		if (file === undefined) {
			// Remaining segments are items inside the deepest module that exists
			// (inline `mod`, re-export, cfg-gated shim). Never drop the edge silently.
			return lastFile;
		}
		lastFile = file;
		// Next modules live beside foo.rs → foo/ or inside foo/ for mod.rs
		if (basename(file) === "mod.rs") dir = dirname(file);
		else dir = join(dirname(file), name);
	}
	return lastFile;
}

function currentModuleDir(fromPath: string): string {
	const base = dirname(fromPath);
	const file = basename(fromPath);
	if (file === "lib.rs" || file === "main.rs" || file === "mod.rs") return base;
	// foo.rs → treat nested mods under foo/
	const stem = file.endsWith(".rs") ? file.slice(0, -3) : file;
	const nested = join(base, stem);
	return nested;
}

async function crateSrcRoot(host: Parameters<FileDepResolver>[2], crateRoot: string): Promise<string> {
	if (
		(await host.isFile(join(crateRoot, "src", "lib.rs"))) ||
		(await host.isFile(join(crateRoot, "src", "main.rs")))
	) {
		return join(crateRoot, "src");
	}
	return crateRoot;
}

function modulePathFromFile(fromPath: string, crateRoot: string): string[] {
	const rel = relative(crateRoot, fromPath);
	if (rel.startsWith("..") || rel.length === 0) return [];
	const parts = rel.split(sep);
	const last = parts.at(-1);
	if (last === undefined) return [];
	if (last === "lib.rs" || last === "main.rs") return parts.slice(0, -1);
	if (last === "mod.rs") return parts.slice(0, -1);
	if (last.endsWith(".rs")) {
		parts[parts.length - 1] = last.slice(0, -3);
		return parts;
	}
	return parts;
}

export const resolveRustFileDep: FileDepResolver = async (fromPath, specifier, host, signal) => {
	signal.throwIfAborted();
	const trimmed = specifier.trim().replace(/;$/u, "");
	if (trimmed.length === 0) return { kind: "unresolved" };

	const cargo = await findAncestorFile(host, dirname(fromPath), host.scopeRoot, "Cargo.toml");
	const crateRoot = cargo !== undefined ? dirname(cargo) : host.scopeRoot;

	// External mod declaration: "mod name"
	const modDecl = /^mod\s+([A-Za-z_][\w]*)$/u.exec(trimmed);
	if (modDecl !== null) {
		const name = modDecl[1];
		if (name === undefined) return { kind: "unresolved" };
		const dir =
			basename(fromPath) === "mod.rs" || basename(fromPath) === "lib.rs" || basename(fromPath) === "main.rs"
				? dirname(fromPath)
				: join(dirname(fromPath), basename(fromPath).replace(/\.rs$/u, ""));
		// Also try beside the file (common for lib.rs siblings)
		const candidates = [
			...(await moduleFileCandidates(dirname(fromPath), name)),
			...(await moduleFileCandidates(dir, name)),
		];
		const file = await firstExistingFile(host, candidates);
		if (file === undefined || !isWithin(host.scopeRoot, file)) return { kind: "unresolved" };
		return internalPaths([file]);
	}

	const segments = splitRustPath(trimmed);
	if (segments.length === 0) return { kind: "unresolved" };

	const head = segments[0];
	if (head === undefined) return { kind: "unresolved" };

	if (head === "crate") {
		const rest = segments.slice(1);
		const srcRoot = await crateSrcRoot(host, crateRoot);
		if (rest.length === 0) {
			const rootFile = await firstExistingFile(host, [join(srcRoot, "lib.rs"), join(srcRoot, "main.rs")]);
			return rootFile === undefined ? { kind: "unresolved" } : internalPaths([rootFile]);
		}
		const file = await resolveModuleChain(host, srcRoot, rest);
		if (file === undefined || !isWithin(host.scopeRoot, file)) return { kind: "unresolved" };
		return internalPaths([file]);
	}

	if (head === "super") {
		const modPath = modulePathFromFile(fromPath, crateRoot);
		const up = segments.filter((s) => s === "super").length;
		const after = segments.filter((s) => s !== "super");
		const basePath = modPath.slice(0, Math.max(0, modPath.length - up));
		const srcRoot = await crateSrcRoot(host, crateRoot);
		const startDir = basePath.length === 0 ? srcRoot : join(srcRoot, ...basePath);
		if (after.length === 0) {
			// parent module file
			if (basePath.length === 0) {
				const rootFile = await firstExistingFile(host, [join(srcRoot, "lib.rs"), join(srcRoot, "main.rs")]);
				return rootFile === undefined ? { kind: "unresolved" } : internalPaths([rootFile]);
			}
			const parentName = basePath[basePath.length - 1];
			const parentDir = join(srcRoot, ...basePath.slice(0, -1));
			if (parentName === undefined) return { kind: "unresolved" };
			const file = await firstExistingFile(host, await moduleFileCandidates(parentDir, parentName));
			return file === undefined ? { kind: "unresolved" } : internalPaths([file]);
		}
		const file = await resolveModuleChain(host, startDir, after);
		if (file === undefined || !isWithin(host.scopeRoot, file)) return { kind: "unresolved" };
		return internalPaths([file]);
	}

	// Relative from current module (self:: already stripped)
	if (head !== "self") {
		// Could be crate-local module from current dir, or external crate.
		const local = await resolveModuleChain(host, currentModuleDir(fromPath), segments);
		if (local !== undefined && isWithin(host.scopeRoot, local)) return internalPaths([local]);
		// Try from src root as absolute module path without crate::
		const srcRoot = await crateSrcRoot(host, crateRoot);
		const fromRoot = await resolveModuleChain(host, srcRoot, segments);
		if (fromRoot !== undefined && isWithin(host.scopeRoot, fromRoot)) return internalPaths([fromRoot]);
		return externalId(head);
	}

	return { kind: "unresolved" };
};
