import { lstat, readFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Decl } from "../ir.ts";
import type { FileSource } from "../engine.ts";
import { packageDeclKey, type PackageSurfaceHost, type PackageSurfaceResolver } from "../package-surface.ts";
import { formatPathForDisplay } from "../traverse.ts";

const RE_EXPORT_DEPTH = 4;
const TS_SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".mtsx"] as const;

type PackageEntry = {
	subpath: string;
	file: string;
};

type SurfaceMember = {
	path: string;
	decl: Decl;
	moduleSpecifier: string;
	importName: string;
};

type ReExport =
	| { kind: "star"; specifier: string }
	| { kind: "named"; specifier: string; names: { exported: string; local: string }[] };

function isWithin(parent: string, child: string): boolean {
	const rel = relative(resolve(parent), resolve(child));
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

async function fileExists(path: string): Promise<boolean> {
	try {
		return (await lstat(path)).isFile();
	} catch {
		return false;
	}
}

async function findPackageJson(startDir: string, stopDir: string): Promise<string | undefined> {
	let dir = resolve(startDir);
	const stop = resolve(stopDir);
	const bounded = isWithin(stop, dir);
	for (;;) {
		const candidate = join(dir, "package.json");
		try {
			if ((await lstat(candidate)).isFile()) return candidate;
		} catch {
			// walk up
		}
		if (bounded && dir === stop) return undefined;
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		if (bounded && !isWithin(stop, parent) && parent !== stop) return undefined;
		dir = parent;
	}
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
	return value as Record<string, unknown>;
}

function pushTarget(out: string[], value: unknown): void {
	if (typeof value === "string" && value.length > 0) {
		out.push(value);
		return;
	}
	if (Array.isArray(value)) {
		for (const entry of value) pushTarget(out, entry);
		return;
	}
	const obj = asRecord(value);
	if (obj === undefined) return;
	for (const key of ["types", "import", "default", "require", "node", "browser"]) {
		if (key in obj) pushTarget(out, obj[key]);
	}
	for (const [key, nested] of Object.entries(obj)) {
		if (key.startsWith(".")) continue;
		if (
			key === "types" ||
			key === "import" ||
			key === "default" ||
			key === "require" ||
			key === "node" ||
			key === "browser"
		) {
			continue;
		}
		pushTarget(out, nested);
	}
}

function exportSubpaths(exportsField: unknown): { subpath: string; targets: string[] }[] {
	if (typeof exportsField === "string" || Array.isArray(exportsField)) {
		const targets: string[] = [];
		pushTarget(targets, exportsField);
		return [{ subpath: ".", targets }];
	}
	const obj = asRecord(exportsField);
	if (obj === undefined) return [];
	const keys = Object.keys(obj);
	const hasSubpaths = keys.some((key) => key === "." || key.startsWith("./"));
	if (!hasSubpaths) {
		const targets: string[] = [];
		pushTarget(targets, exportsField);
		return [{ subpath: ".", targets }];
	}
	const out: { subpath: string; targets: string[] }[] = [];
	for (const [subpath, value] of Object.entries(obj)) {
		if (subpath !== "." && !subpath.startsWith("./")) continue;
		const targets: string[] = [];
		pushTarget(targets, value);
		out.push({ subpath, targets });
	}
	return out;
}

function moduleSpecifierFor(packageName: string, subpath: string): string {
	if (subpath === "." || subpath === "") return packageName;
	if (subpath.startsWith("./")) return `${packageName}/${subpath.slice(2)}`;
	return `${packageName}/${subpath}`;
}

function distToSrcPath(absolute: string): string | undefined {
	const parts = resolve(absolute).split(sep);
	const distAt = parts.lastIndexOf("dist");
	if (distAt <= 0) return undefined;
	const rewritten = parts.slice();
	rewritten[distAt] = "src";
	return rewritten.join(sep);
}

function pushTsStems(out: string[], stem: string): void {
	for (const sourceExt of TS_SOURCE_EXTENSIONS) out.push(`${stem}${sourceExt}`);
}

function sourceCandidatesFromSeed(seed: string): string[] {
	const out = [seed];
	const ext = extname(seed);
	if (ext === ".js" || ext === ".mjs" || ext === ".cjs" || ext === ".jsx") {
		pushTsStems(out, seed.slice(0, -ext.length));
	} else if (seed.endsWith(".d.ts")) {
		pushTsStems(out, seed.slice(0, -".d.ts".length));
	} else if (ext === "") {
		for (const sourceExt of TS_SOURCE_EXTENSIONS) {
			out.push(`${seed}${sourceExt}`, join(seed, `index${sourceExt}`));
		}
	}
	return out;
}

async function firstExistingTs(candidates: readonly string[]): Promise<string | undefined> {
	for (const candidate of candidates) {
		if (!(await fileExists(candidate))) continue;
		const candidateExt = extname(candidate);
		if (candidate.endsWith(".d.ts")) continue;
		if (candidateExt === ".js" || candidateExt === ".mjs" || candidateExt === ".cjs" || candidateExt === ".jsx") {
			continue;
		}
		if (TS_SOURCE_EXTENSIONS.includes(candidateExt as (typeof TS_SOURCE_EXTENSIONS)[number])) {
			return candidate;
		}
	}
	return undefined;
}

/** Relative module resolve for re-exports. */
async function resolveRelativeSource(baseDir: string, target: string): Promise<string | undefined> {
	if (target.startsWith("node:") || target.startsWith("data:")) return undefined;
	if (!target.startsWith("./") && !target.startsWith("../")) return undefined;
	const absolute = resolve(baseDir, target);
	const seeds = [absolute];
	const fromDist = distToSrcPath(absolute);
	if (fromDist !== undefined) seeds.push(fromDist);
	return firstExistingTs(seeds.flatMap((seed) => sourceCandidatesFromSeed(seed)));
}

async function resolvePackageEntrySource(packageRoot: string, target: string): Promise<string | undefined> {
	if (target.startsWith("node:") || target.startsWith("data:")) return undefined;
	const absolute = resolve(packageRoot, target);
	const seeds = [absolute];
	const fromDist = distToSrcPath(absolute);
	if (fromDist !== undefined) seeds.push(fromDist);
	const slashPath = absolute.split(sep).join("/");
	const srcMarker = "/src/";
	const srcAt = slashPath.lastIndexOf(srcMarker);
	if (srcAt >= 0) {
		const tail = slashPath.slice(srcAt + srcMarker.length);
		seeds.push(resolve(packageRoot, "src", ...tail.split("/").filter((p) => p.length > 0)));
	}
	for (const sourceExt of TS_SOURCE_EXTENSIONS) {
		seeds.push(join(packageRoot, `src/index${sourceExt}`));
		seeds.push(join(packageRoot, `index${sourceExt}`));
	}
	return firstExistingTs(seeds.flatMap((seed) => sourceCandidatesFromSeed(seed)));
}

async function resolvePackageEntries(packageRoot: string, manifest: Record<string, unknown>): Promise<PackageEntry[]> {
	const out: PackageEntry[] = [];
	const seen = new Set<string>();
	const add = async (subpath: string, target: string): Promise<void> => {
		const file = await resolvePackageEntrySource(packageRoot, target);
		if (file === undefined) return;
		const key = `${subpath}\0${file}`;
		if (seen.has(key)) return;
		seen.add(key);
		out.push({ subpath, file });
	};
	if (manifest.exports !== undefined) {
		for (const entry of exportSubpaths(manifest.exports)) {
			for (const target of entry.targets) await add(entry.subpath, target);
		}
	}
	if (out.length === 0) {
		for (const field of ["types", "module", "main"] as const) {
			const value = manifest[field];
			if (typeof value === "string") await add(".", value);
		}
	}
	return out;
}

function parseReExports(source: string): ReExport[] {
	const out: ReExport[] = [];
	const text = source.replace(/\/\*[\s\S]*?\*\//gu, " ").replace(/(^|[^:])\/\/.*$/gmu, "$1");
	for (const match of text.matchAll(
		/\bexport\s+(?:type\s+)?\*\s+(?:as\s+[A-Za-z_$][\w$]*\s+)?from\s+["']([^"']+)["']/gu,
	)) {
		const specifier = match[1];
		if (specifier !== undefined) out.push({ kind: "star", specifier });
	}
	for (const match of text.matchAll(/\bexport\s+(?:type\s+)?\{([^}]+)\}\s*from\s+["']([^"']+)["']/gu)) {
		const body = match[1];
		const specifier = match[2];
		if (body === undefined || specifier === undefined) continue;
		const names: { exported: string; local: string }[] = [];
		for (const part of body.split(",")) {
			const cleaned = part
				.trim()
				.replace(/^type\s+/u, "")
				.trim();
			if (cleaned.length === 0) continue;
			const asMatch = /^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/u.exec(cleaned);
			if (asMatch !== null) {
				const local = asMatch[1];
				const exported = asMatch[2];
				if (local !== undefined && exported !== undefined) names.push({ local, exported });
				continue;
			}
			const id = /^([A-Za-z_$][\w$]*)$/u.exec(cleaned);
			const name = id?.[1];
			if (name !== undefined) names.push({ local: name, exported: name });
		}
		if (names.length > 0) out.push({ kind: "named", specifier, names });
	}
	return out;
}

function formatImportAccess(moduleSpecifier: string, importName: string): string {
	if (importName === "default") return `import defaultExport from "${moduleSpecifier}"`;
	return `import { ${importName} } from "${moduleSpecifier}"`;
}

function addSurfaceMember(into: Map<string, SurfaceMember>, member: SurfaceMember): void {
	const key = packageDeclKey(member.path, member.decl);
	if (!into.has(key)) into.set(key, member);
}

/** Exported roots + public members under exported owners (IR-level; used after TS entry resolve). */
function collectExportedTree(
	into: Map<string, SurfaceMember>,
	file: FileSource,
	moduleSpecifier: string,
	importNameFor: (decl: Decl) => string | undefined,
): void {
	const go = (decls: readonly Decl[], rootImportName: string | undefined): void => {
		for (const decl of decls) {
			let nextRoot = rootImportName;
			if (rootImportName === undefined && decl.exported) {
				const importName = importNameFor(decl);
				if (importName !== undefined) {
					addSurfaceMember(into, {
						path: file.ir.path,
						decl,
						moduleSpecifier,
						importName,
					});
					nextRoot = importName;
				}
			} else if (rootImportName !== undefined && decl.visibility === "public") {
				addSurfaceMember(into, {
					path: file.ir.path,
					decl,
					moduleSpecifier,
					importName: rootImportName,
				});
			}
			go(decl.children, nextRoot);
		}
	};
	go(file.ir.decls, undefined);
}

async function collectFromEntries(
	host: PackageSurfaceHost,
	scopeRoot: string,
	packageName: string,
	entries: readonly PackageEntry[],
	signal: AbortSignal,
): Promise<Map<string, SurfaceMember>> {
	const members = new Map<string, SurfaceMember>();
	type QueueItem = {
		file: string;
		depth: number;
		moduleSpecifier: string;
		nameFilter: ReadonlyMap<string, string> | undefined;
	};
	const queue: QueueItem[] = entries.map((entry) => ({
		file: entry.file,
		depth: 0,
		moduleSpecifier: moduleSpecifierFor(packageName, entry.subpath),
		nameFilter: undefined,
	}));
	const seen = new Set<string>();

	while (queue.length > 0) {
		signal.throwIfAborted();
		const item = queue.shift();
		if (item === undefined) break;
		const filterKey =
			item.nameFilter === undefined
				? "*"
				: [...item.nameFilter.entries()]
						.map(([local, exported]) => `${local}>${exported}`)
						.sort()
						.join(",");
		const visitKey = `${item.file}\0${item.moduleSpecifier}\0${filterKey}`;
		if (seen.has(visitKey)) continue;
		seen.add(visitKey);

		if (!host.ownsPath(item.file)) continue;

		let file: FileSource;
		try {
			file = await host.sourceForFile(item.file);
		} catch {
			continue;
		}

		if (isWithin(scopeRoot, file.ir.path)) {
			collectExportedTree(members, file, item.moduleSpecifier, (decl) =>
				item.nameFilter === undefined ? decl.name : item.nameFilter.get(decl.name),
			);
		}

		if (item.depth >= RE_EXPORT_DEPTH) continue;
		for (const re of parseReExports(file.source)) {
			const target = await resolveRelativeSource(dirname(file.ir.path), re.specifier);
			if (target === undefined) continue;
			if (re.kind === "star") {
				queue.push({
					file: target,
					depth: item.depth + 1,
					moduleSpecifier: item.moduleSpecifier,
					nameFilter: item.nameFilter,
				});
				continue;
			}
			const names = new Map<string, string>();
			for (const name of re.names) {
				if (item.nameFilter === undefined) {
					names.set(name.local, name.exported);
					continue;
				}
				const exposedAs = item.nameFilter.get(name.exported);
				if (exposedAs === undefined) continue;
				names.set(name.local, exposedAs);
			}
			if (names.size === 0) continue;
			queue.push({
				file: target,
				depth: item.depth + 1,
				moduleSpecifier: item.moduleSpecifier,
				nameFilter: names,
			});
		}
	}

	return members;
}

/**
 * Node/TS package surface: nearest package.json exports/main, dist→src, cheap re-export walk.
 * Shared by typescript + tsx adapters (same resolver function identity).
 */
export const resolveTypescriptPackageSurface: PackageSurfaceResolver = async (scopeRoot, host, signal) => {
	const packageJsonPath = await findPackageJson(scopeRoot, host.cwd);
	if (packageJsonPath === undefined) return undefined;

	let manifest: Record<string, unknown>;
	try {
		manifest = JSON.parse(await readFile(packageJsonPath, "utf8")) as Record<string, unknown>;
	} catch {
		throw new Error(`packageSurface could not parse ${formatPathForDisplay(packageJsonPath, host.cwd)}`);
	}
	const packageName = typeof manifest.name === "string" && manifest.name.length > 0 ? manifest.name : undefined;
	if (packageName === undefined) {
		throw new Error("packageSurface requires package.json name");
	}

	const packageRoot = dirname(packageJsonPath);
	const entries = await resolvePackageEntries(packageRoot, manifest);
	const owned = entries.filter((entry) => host.ownsPath(entry.file));
	if (owned.length === 0) {
		// package.json exists but no resolvable TS/TSX entry in scope ownership.
		return {
			declKeys: new Set(),
			accessByDecl: new Map(),
			paths: [],
			filesVisited: 0,
		};
	}

	const members = await collectFromEntries(host, scopeRoot, packageName, owned, signal);
	const declKeys = new Set<string>();
	const accessByDecl = new Map<string, string>();
	const paths = new Set<string>();
	for (const [key, member] of members) {
		declKeys.add(key);
		accessByDecl.set(key, formatImportAccess(member.moduleSpecifier, member.importName));
		paths.add(member.path);
	}

	return {
		declKeys,
		accessByDecl,
		paths: [...paths],
		filesVisited: paths.size,
	};
};
