import { readFile } from "node:fs/promises";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import type { FileDepHost, FileDepResolver } from "../adapter.ts";
import {
	externalId,
	findAncestorFile,
	firstExistingFile,
	internalPaths,
	isWithin,
	packageNameFromBareSpecifier,
} from "./file-dep-util.ts";

const TS_SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".mtsx"] as const;

type TsPathMapping = {
	pattern: string;
	/** Directory paths are resolved against (configDir + baseUrl of defining tsconfig). */
	baseDir: string;
	targets: string[];
};

type TsPathsConfig = {
	mappings: TsPathMapping[];
};

function pushTsStems(out: string[], stem: string): void {
	for (const sourceExt of TS_SOURCE_EXTENSIONS) out.push(`${stem}${sourceExt}`);
}

function sourceCandidatesFromSeed(seed: string): string[] {
	const out = [seed];
	const ext = extname(seed);
	if (ext === ".js" || ext === ".mjs" || ext === ".cjs" || ext === ".jsx") {
		pushTsStems(out, seed.slice(0, -ext.length));
		if (ext === ".jsx") out.push(`${seed.slice(0, -ext.length)}.tsx`);
	} else if (seed.endsWith(".d.ts")) {
		pushTsStems(out, seed.slice(0, -".d.ts".length));
	} else if (ext === "") {
		for (const sourceExt of TS_SOURCE_EXTENSIONS) {
			out.push(`${seed}${sourceExt}`, join(seed, `index${sourceExt}`));
		}
	} else if (TS_SOURCE_EXTENSIONS.includes(ext as (typeof TS_SOURCE_EXTENSIONS)[number])) {
		// already exact
	} else {
		pushTsStems(out, seed);
		for (const sourceExt of TS_SOURCE_EXTENSIONS) out.push(join(seed, `index${sourceExt}`));
	}
	return out;
}

async function resolveExistingSource(host: FileDepHost, seed: string): Promise<string | undefined> {
	const candidates = sourceCandidatesFromSeed(seed);
	const preferred = candidates.filter((path) => {
		if (path.endsWith(".d.ts")) return false;
		const ext = extname(path);
		return ext !== ".js" && ext !== ".mjs" && ext !== ".cjs" && ext !== ".jsx";
	});
	const hit = await firstExistingFile(host, preferred);
	if (hit !== undefined) return hit;
	return firstExistingFile(host, candidates);
}

async function resolveRelative(host: FileDepHost, baseDir: string, target: string): Promise<string | undefined> {
	return resolveExistingSource(host, resolve(baseDir, target));
}

/**
 * Enough JSONC for tsconfig: // line comments + trailing commas.
 * Does not strip block comments with a regex — that eats path strings like `"./*"`.
 */
function parseJsonc(text: string): unknown {
	const lines = text.split("\n").map((line) => {
		let inString = false;
		let escape = false;
		for (let i = 0; i < line.length; i += 1) {
			const ch = line.charAt(i);
			if (escape) {
				escape = false;
				continue;
			}
			if (inString && ch === "\\") {
				escape = true;
				continue;
			}
			if (ch === '"') {
				inString = !inString;
				continue;
			}
			if (!inString && ch === "/" && line.charAt(i + 1) === "/") {
				return line.slice(0, i);
			}
		}
		return line;
	});
	const noTrail = lines.join("\n").replace(/,(\s*[}\]])/gu, "$1");
	return JSON.parse(noTrail) as unknown;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
	return value as Record<string, unknown>;
}

function readPathsObject(value: unknown): Record<string, string[]> {
	const obj = asRecord(value);
	if (obj === undefined) return {};
	const out: Record<string, string[]> = {};
	for (const [pattern, targets] of Object.entries(obj)) {
		if (!Array.isArray(targets)) continue;
		const list = targets.filter((t): t is string => typeof t === "string" && t.length > 0);
		if (list.length > 0) out[pattern] = list;
	}
	return out;
}

/**
 * Match `spec` against a TS paths pattern. Returns the `*` capture, or `""` for
 * exact patterns, or undefined on no match.
 */
function matchPathPattern(pattern: string, spec: string): string | undefined {
	const star = pattern.indexOf("*");
	if (star === -1) return pattern === spec ? "" : undefined;
	const prefix = pattern.slice(0, star);
	const suffix = pattern.slice(star + 1);
	if (!spec.startsWith(prefix) || !spec.endsWith(suffix)) return undefined;
	if (spec.length < prefix.length + suffix.length) return undefined;
	return spec.slice(prefix.length, spec.length - suffix.length);
}

function applyStar(target: string, capture: string): string {
	const star = target.indexOf("*");
	if (star === -1) return target;
	return `${target.slice(0, star)}${capture}${target.slice(star + 1)}`;
}

async function loadTsconfigFile(path: string): Promise<Record<string, unknown> | undefined> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch {
		return undefined;
	}
	try {
		return asRecord(parseJsonc(text));
	} catch {
		return undefined;
	}
}

function resolveExtendsPath(fromConfig: string, extendsSpec: string): string {
	const parentDir = dirname(fromConfig);
	if (extendsSpec.endsWith(".json")) return resolve(parentDir, extendsSpec);
	return resolve(parentDir, `${extendsSpec}.json`);
}

/**
 * Nearest tsconfig/jsconfig paths + extends merge. Targets resolve against the
 * defining config's directory + baseUrl (TypeScript rules).
 */
async function loadTsPathsConfig(
	host: FileDepHost,
	fromPath: string,
	signal: AbortSignal,
): Promise<TsPathsConfig | undefined> {
	const startDir = dirname(fromPath);
	const tsconfig =
		(await findAncestorFile(host, startDir, host.scopeRoot, "tsconfig.json")) ??
		(await findAncestorFile(host, startDir, host.scopeRoot, "jsconfig.json"));
	if (tsconfig === undefined) return undefined;

	const memoKey = `ts-paths:${tsconfig}`;
	const cached = host.memo.get(memoKey);
	if (cached !== undefined) return cached as TsPathsConfig;

	// Root → leaf so leaf overrides.
	const chain: string[] = [];
	let current: string | undefined = tsconfig;
	const seen = new Set<string>();
	while (current !== undefined && !seen.has(current)) {
		signal.throwIfAborted();
		seen.add(current);
		chain.push(current);
		const json = await loadTsconfigFile(current);
		if (json === undefined) break;
		const ext = json.extends;
		if (typeof ext !== "string" || ext.length === 0) break;
		const parent = resolveExtendsPath(current, ext);
		if (!isWithin(host.scopeRoot, parent) && resolve(parent) !== resolve(host.scopeRoot)) break;
		current = parent;
	}

	const byPattern = new Map<string, TsPathMapping>();
	for (const configPath of [...chain].reverse()) {
		signal.throwIfAborted();
		const json = await loadTsconfigFile(configPath);
		if (json === undefined) continue;
		const compiler = asRecord(json.compilerOptions);
		if (compiler === undefined) continue;
		const configDir = dirname(configPath);
		const baseUrl = typeof compiler.baseUrl === "string" && compiler.baseUrl.length > 0 ? compiler.baseUrl : ".";
		const baseDir = resolve(configDir, baseUrl);
		const paths = readPathsObject(compiler.paths);
		for (const [pattern, targets] of Object.entries(paths)) {
			byPattern.set(pattern, { pattern, baseDir, targets });
		}
	}

	const mappings = [...byPattern.values()].sort(
		(a, b) => b.pattern.length - a.pattern.length || (a.pattern < b.pattern ? -1 : 1),
	);
	const config: TsPathsConfig = { mappings };
	host.memo.set(memoKey, config);
	return config;
}

async function resolveViaPaths(
	host: FileDepHost,
	fromPath: string,
	specifier: string,
	signal: AbortSignal,
): Promise<string | undefined> {
	const config = await loadTsPathsConfig(host, fromPath, signal);
	if (config === undefined || config.mappings.length === 0) return undefined;

	for (const mapping of config.mappings) {
		signal.throwIfAborted();
		const capture = matchPathPattern(mapping.pattern, specifier);
		if (capture === undefined) continue;
		for (const target of mapping.targets) {
			const mapped = applyStar(target, capture);
			// Guard obvious escapes outside scope after mapping.
			const seed = resolve(mapping.baseDir, mapped);
			const scopeRel = relative(resolve(host.scopeRoot), seed);
			if (scopeRel.startsWith(`..${sep}`) || scopeRel === "..") continue;
			const file = await resolveExistingSource(host, seed);
			if (file !== undefined) return file;
		}
	}
	return undefined;
}

/** package name → package root, from the scope root's npm workspaces globs. */
type WorkspaceMap = Map<string, string>;

async function readManifest(path: string): Promise<Record<string, unknown> | undefined> {
	const json = await loadTsconfigFile(path);
	return json;
}

function workspaceGlobs(manifest: Record<string, unknown>): string[] {
	const value = manifest.workspaces;
	if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === "string");
	const packages = asRecord(value)?.packages;
	if (Array.isArray(packages)) return packages.filter((entry): entry is string => typeof entry === "string");
	return [];
}

/**
 * Workspace packages resolve through an npm symlink the resolver must not follow:
 * a `/node_modules/` path fails `host.ownsPath` and would duplicate the real file.
 * Expand the globs against the scope root instead.
 */
async function loadWorkspacePackages(host: FileDepHost, signal: AbortSignal): Promise<WorkspaceMap> {
	const key = `ts-workspaces:${host.scopeRoot}`;
	const cached = host.memo.get(key);
	if (cached !== undefined) return cached as WorkspaceMap;

	const map: WorkspaceMap = new Map();
	const root = await readManifest(join(host.scopeRoot, "package.json"));
	for (const glob of root === undefined ? [] : workspaceGlobs(root)) {
		signal.throwIfAborted();
		const star = glob.indexOf("*");
		const dirs: string[] = [];
		if (star === -1) {
			dirs.push(resolve(host.scopeRoot, glob));
		} else {
			const parent = resolve(host.scopeRoot, glob.slice(0, star).replace(/\/$/u, ""));
			for (const name of await host.readDir(parent)) {
				if (name.startsWith(".")) continue;
				dirs.push(join(parent, name));
			}
		}
		for (const dir of dirs) {
			const manifest = await readManifest(join(dir, "package.json"));
			const name = manifest?.name;
			if (typeof name === "string" && name.length > 0) map.set(name, dir);
		}
	}

	host.memo.set(key, map);
	return map;
}

function entryTargets(manifest: Record<string, unknown>): string[] {
	const out: string[] = [];
	const exports = manifest.exports;
	if (typeof exports === "string") out.push(exports);
	const dot = asRecord(exports)?.["."];
	if (typeof dot === "string") out.push(dot);
	const conditions = asRecord(dot);
	if (conditions !== undefined) {
		for (const field of ["types", "import", "module", "default"] as const) {
			const value = conditions[field];
			if (typeof value === "string") out.push(value);
		}
	}
	for (const field of ["types", "module", "main"] as const) {
		const value = manifest[field];
		if (typeof value === "string") out.push(value);
	}
	out.push("src/index.ts", "index.ts");
	return out;
}

async function resolveWorkspacePackage(
	host: FileDepHost,
	specifier: string,
	signal: AbortSignal,
): Promise<string | undefined> {
	const workspaces = await loadWorkspacePackages(host, signal);
	if (workspaces.size === 0) return undefined;

	let matched: { name: string; dir: string } | undefined;
	for (const [name, dir] of workspaces) {
		if (specifier !== name && !specifier.startsWith(`${name}/`)) continue;
		if (matched === undefined || name.length > matched.name.length) matched = { name, dir };
	}
	if (matched === undefined) return undefined;

	if (specifier.length > matched.name.length) {
		const subpath = specifier.slice(matched.name.length + 1);
		return (
			(await resolveExistingSource(host, resolve(matched.dir, subpath))) ??
			(await resolveExistingSource(host, resolve(matched.dir, "src", subpath)))
		);
	}

	const manifest = await readManifest(join(matched.dir, "package.json"));
	if (manifest === undefined) return undefined;
	for (const target of entryTargets(manifest)) {
		const file = await resolveExistingSource(host, resolve(matched.dir, target));
		if (file !== undefined) return file;
	}
	return undefined;
}

export const resolveTypescriptFileDep: FileDepResolver = async (fromPath, specifier, host, signal) => {
	signal.throwIfAborted();
	const trimmed = specifier.trim();
	if (trimmed.length === 0) return { kind: "unresolved" };
	if (trimmed.startsWith("node:") || trimmed.startsWith("data:")) {
		return externalId(packageNameFromBareSpecifier(trimmed));
	}
	if (trimmed.startsWith("./") || trimmed.startsWith("../")) {
		const file = await resolveRelative(host, dirname(fromPath), trimmed);
		if (file === undefined) return { kind: "unresolved" };
		return internalPaths([file]);
	}

	const aliased = await resolveViaPaths(host, fromPath, trimmed, signal);
	if (aliased !== undefined) return internalPaths([aliased]);

	const workspace = await resolveWorkspacePackage(host, trimmed, signal);
	if (workspace !== undefined && isWithin(host.scopeRoot, workspace)) return internalPaths([workspace]);

	return externalId(packageNameFromBareSpecifier(trimmed));
};
