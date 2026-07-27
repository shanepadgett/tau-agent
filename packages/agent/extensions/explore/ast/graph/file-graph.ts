import { lstat, opendir } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { FileDepHost, LanguageAdapter } from "../adapter.ts";
import type { ExploreEngine } from "../engine.ts";
import { scanSources } from "../scan.ts";
import { formatPathForDisplay, pathResolutionError, resolveExplorePath } from "../../traverse.ts";

export type FileGraphEdge =
	| { kind: "internal"; from: string; to: string }
	| { kind: "external"; from: string; id: string };

export type FileDepHit = {
	depth: number;
	/** Absolute path for internal hits. */
	path: string | undefined;
	/** External package/module id. */
	externalId: string | undefined;
};

export type FileDepQueryResult = {
	seedPath: string;
	depth: number;
	hits: FileDepHit[];
	resultLimit: number;
	resultLimitReached: boolean;
};

export type ExploreFileGraph = {
	deps(path: string, depth: number, resultLimit: number, signal: AbortSignal): Promise<FileDepQueryResult>;
	reverseDeps(path: string, depth: number, resultLimit: number, signal: AbortSignal): Promise<FileDepQueryResult>;
	/** Forward edges for one file (impact/relationships). */
	forwardEdges(path: string, signal: AbortSignal): Promise<readonly FileGraphEdge[]>;
	invalidate(paths: readonly string[]): void;
	clear(): void;
};

type ForwardEntry = {
	contentHash: string;
	edges: FileGraphEdge[];
};

type ReverseIndex = {
	/** target absolute path → importers */
	byTarget: Map<string, string[]>;
};

function isWithin(parent: string, child: string): boolean {
	const rel = relative(resolve(parent), resolve(child));
	return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await lstat(path);
		return true;
	} catch {
		return false;
	}
}

async function isFile(path: string): Promise<boolean> {
	try {
		return (await lstat(path)).isFile();
	} catch {
		return false;
	}
}

async function readDir(path: string): Promise<string[]> {
	try {
		const dir = await opendir(path);
		const names: string[] = [];
		for await (const entry of dir) names.push(entry.name);
		return names;
	} catch {
		return [];
	}
}

async function nearestGitRoot(startDir: string): Promise<string | undefined> {
	let dir = resolve(startDir);
	for (;;) {
		if (await pathExists(resolve(dir, ".git"))) return dir;
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

async function scopeRootFor(absolutePath: string, cwd: string): Promise<string> {
	if (isWithin(cwd, absolutePath)) return cwd;
	const git = await nearestGitRoot(dirname(absolutePath));
	if (git !== undefined) return git;
	return dirname(absolutePath);
}

function requireFileDepsAdapter(
	adapter: LanguageAdapter | undefined,
	absolutePath: string,
	cwd: string,
): LanguageAdapter {
	if (adapter === undefined) {
		throw new Error(`Unsupported language for path: ${formatPathForDisplay(absolutePath, cwd)}`);
	}
	if (!adapter.capabilities.fileDeps || adapter.resolveFileDep === undefined) {
		throw new Error(`File dependency graph unavailable for ${adapter.id} (fileDeps capability not supported)`);
	}
	return adapter;
}

function sortUnique(paths: readonly string[]): string[] {
	return [...new Set(paths.map((path) => resolve(path)))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Session file-import graph. Shared code never interprets import syntax —
 * adapters own resolveFileDep.
 */
export function createFileGraph(engine: ExploreEngine): ExploreFileGraph {
	const forwardCache = new Map<string, ForwardEntry>();
	const reverseCache = new Map<string, ReverseIndex>();
	const memo = new Map<string, unknown>();

	const makeHost = (scopeRoot: string): FileDepHost => ({
		cwd: engine.cwd,
		scopeRoot,
		pathExists,
		isFile,
		readDir,
		ownsPath: (path) => {
			const adapter = engine.registry.adapterForPath(path);
			return adapter !== undefined && adapter.capabilities.fileDeps;
		},
		memo,
	});

	const loadForward = async (
		absolutePath: string,
		scopeRoot: string,
		signal: AbortSignal,
	): Promise<FileGraphEdge[]> => {
		signal.throwIfAborted();
		const adapter = requireFileDepsAdapter(engine.registry.adapterForPath(absolutePath), absolutePath, engine.cwd);
		const resolveFileDep = adapter.resolveFileDep;
		if (resolveFileDep === undefined) {
			throw new Error(`File dependency graph unavailable for ${adapter.id} (fileDeps capability not supported)`);
		}

		const ir = await engine.irForFile(absolutePath);
		const cached = forwardCache.get(absolutePath);
		if (cached !== undefined && cached.contentHash === ir.contentHash) return cached.edges;

		const host = makeHost(scopeRoot);
		const edges: FileGraphEdge[] = [];
		const seenInternal = new Set<string>();
		const seenExternal = new Set<string>();

		for (const imp of ir.imports) {
			signal.throwIfAborted();
			const resolution = await resolveFileDep(absolutePath, imp.specifier, host, signal);
			if (resolution.kind === "unresolved") continue;
			if (resolution.kind === "external") {
				if (seenExternal.has(resolution.id)) continue;
				seenExternal.add(resolution.id);
				edges.push({ kind: "external", from: absolutePath, id: resolution.id });
				continue;
			}
			for (const target of sortUnique(resolution.paths)) {
				if (!isWithin(scopeRoot, target)) continue;
				if (!host.ownsPath(target)) continue;
				if (target === absolutePath) continue;
				if (seenInternal.has(target)) continue;
				seenInternal.add(target);
				edges.push({ kind: "internal", from: absolutePath, to: target });
			}
		}

		forwardCache.set(absolutePath, { contentHash: ir.contentHash, edges });
		return edges;
	};

	const ensureReverse = async (scopeRoot: string, signal: AbortSignal): Promise<ReverseIndex> => {
		const cached = reverseCache.get(scopeRoot);
		if (cached !== undefined) return cached;

		const byTarget = new Map<string, string[]>();
		const scan = scanSources({
			engine,
			cwd: engine.cwd,
			root: scopeRoot,
			signal,
		});
		let step = await scan.next();
		while (!step.done) {
			signal.throwIfAborted();
			const filePath = step.value.ir.path;
			const adapter = engine.registry.adapterForPath(filePath);
			if (adapter?.capabilities.fileDeps === true && adapter.resolveFileDep !== undefined) {
				try {
					const edges = await loadForward(filePath, scopeRoot, signal);
					for (const edge of edges) {
						if (edge.kind !== "internal") continue;
						const list = byTarget.get(edge.to);
						if (list === undefined) byTarget.set(edge.to, [edge.from]);
						else if (!list.includes(edge.from)) list.push(edge.from);
					}
				} catch {
					// Skip files that fail resolve/parse during reverse build; keep scanning.
				}
			}
			step = await scan.next();
		}

		for (const [, importers] of byTarget) {
			importers.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
		}

		const index: ReverseIndex = { byTarget };
		reverseCache.set(scopeRoot, index);
		return index;
	};

	const collectForwardHits = async (
		seedPath: string,
		depth: number,
		resultLimit: number,
		signal: AbortSignal,
	): Promise<FileDepQueryResult> => {
		const scopeRoot = await scopeRootFor(seedPath, engine.cwd);
		const hits: FileDepHit[] = [];
		let resultLimitReached = false;
		const listedInternal = new Set<string>();
		const listedExternal = new Set<string>();

		const queue: { path: string; depth: number }[] = [{ path: seedPath, depth: 0 }];
		const visited = new Set<string>([seedPath]);

		while (queue.length > 0) {
			signal.throwIfAborted();
			const current = queue.shift();
			if (current === undefined) break;
			if (current.depth >= depth) continue;

			const edges = await loadForward(current.path, scopeRoot, signal);
			const nextDepth = current.depth + 1;

			for (const edge of edges) {
				if (hits.length >= resultLimit) {
					resultLimitReached = true;
					break;
				}
				if (edge.kind === "external") {
					if (listedExternal.has(edge.id)) continue;
					listedExternal.add(edge.id);
					hits.push({ depth: nextDepth, path: undefined, externalId: edge.id });
					continue;
				}
				if (listedInternal.has(edge.to)) continue;
				listedInternal.add(edge.to);
				hits.push({ depth: nextDepth, path: edge.to, externalId: undefined });
				if (nextDepth < depth && !visited.has(edge.to)) {
					visited.add(edge.to);
					queue.push({ path: edge.to, depth: nextDepth });
				}
			}
			if (resultLimitReached) break;
		}

		return { seedPath, depth, hits, resultLimit, resultLimitReached };
	};

	const collectReverseHits = async (
		seedPath: string,
		depth: number,
		resultLimit: number,
		signal: AbortSignal,
	): Promise<FileDepQueryResult> => {
		const scopeRoot = await scopeRootFor(seedPath, engine.cwd);
		const index = await ensureReverse(scopeRoot, signal);
		const hits: FileDepHit[] = [];
		let resultLimitReached = false;
		const listed = new Set<string>();

		const queue: { path: string; depth: number }[] = [{ path: seedPath, depth: 0 }];
		const visited = new Set<string>([seedPath]);

		while (queue.length > 0) {
			signal.throwIfAborted();
			const current = queue.shift();
			if (current === undefined) break;
			if (current.depth >= depth) continue;

			const importers = index.byTarget.get(current.path) ?? [];
			const nextDepth = current.depth + 1;
			for (const importer of importers) {
				if (hits.length >= resultLimit) {
					resultLimitReached = true;
					break;
				}
				if (listed.has(importer)) continue;
				listed.add(importer);
				hits.push({ depth: nextDepth, path: importer, externalId: undefined });
				if (nextDepth < depth && !visited.has(importer)) {
					visited.add(importer);
					queue.push({ path: importer, depth: nextDepth });
				}
			}
			if (resultLimitReached) break;
		}

		return { seedPath, depth, hits, resultLimit, resultLimitReached };
	};

	const resolveSeedFile = async (pathInput: string): Promise<string> => {
		const absolutePath = resolveExplorePath(engine.cwd, pathInput);
		let stats;
		try {
			stats = await lstat(absolutePath);
		} catch (error) {
			throw pathResolutionError(error, pathInput);
		}
		if (!stats.isFile()) {
			throw new Error(`Not a file: ${formatPathForDisplay(absolutePath, engine.cwd)}`);
		}
		requireFileDepsAdapter(engine.registry.adapterForPath(absolutePath), absolutePath, engine.cwd);
		return absolutePath;
	};

	return {
		async deps(path, depth, resultLimit, signal) {
			const seed = await resolveSeedFile(path);
			return collectForwardHits(seed, depth, resultLimit, signal);
		},

		async reverseDeps(path, depth, resultLimit, signal) {
			const seed = await resolveSeedFile(path);
			return collectReverseHits(seed, depth, resultLimit, signal);
		},

		async forwardEdges(path, signal) {
			const seed = await resolveSeedFile(path);
			const scopeRoot = await scopeRootFor(seed, engine.cwd);
			return loadForward(seed, scopeRoot, signal);
		},

		invalidate(paths) {
			for (const path of paths) {
				forwardCache.delete(resolveExplorePath(engine.cwd, path));
			}
			reverseCache.clear();
			memo.clear();
		},

		clear() {
			forwardCache.clear();
			reverseCache.clear();
			memo.clear();
		},
	};
}
