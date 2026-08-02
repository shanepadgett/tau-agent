import { lstat, opendir } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { FileDepHost, FileDepResolution, LanguageAdapter } from "../adapter.ts";
import type { ExploreEngine } from "../engine.ts";
import { scanSources } from "../scan.ts";
import { formatPathForDisplay, pathResolutionError, resolveExplorePath } from "../traverse.ts";

export type FileGraphEdge =
	| { kind: "internal"; from: string; to: string }
	| { kind: "package"; from: string; id: string; dir: string; fileCount: number }
	| { kind: "external"; from: string; id: string };

/** One resolved dependency endpoint, independent of traversal depth. */
export type FileDepTarget =
	| { kind: "internal"; path: string }
	/** In-repo directory too large to list; `id` is the import as written. */
	| { kind: "package"; id: string; dir: string; fileCount: number }
	| { kind: "external"; id: string };

export type FileDepHit = { depth: number } & FileDepTarget;

export type FileDepQueryResult = {
	seedPath: string;
	depth: number;
	hits: FileDepHit[];
	resultLimit: number;
	resultLimitReached: boolean;
	/** External edges dropped after the external cap (internal edges keep the full limit). */
	externalOmitted: number;
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

/** External ids are cheap noise in bulk; in-repo edges get the caller's full budget. */
const EXTERNAL_HIT_LIMIT = 10;

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

type EdgeSeen = {
	internal: Set<string>;
	package: Set<string>;
	external: Set<string>;
};

function emptyEdgeSeen(): EdgeSeen {
	return { internal: new Set(), package: new Set(), external: new Set() };
}

function appendInternalPaths(
	edges: FileGraphEdge[],
	from: string,
	paths: readonly string[],
	scopeRoot: string,
	ownsPath: (path: string) => boolean,
	seen: Set<string>,
): void {
	for (const target of sortUnique(paths)) {
		if (!isWithin(scopeRoot, target)) continue;
		if (!ownsPath(target)) continue;
		if (target === from) continue;
		if (seen.has(target)) continue;
		seen.add(target);
		edges.push({ kind: "internal", from, to: target });
	}
}

function appendResolution(
	edges: FileGraphEdge[],
	from: string,
	resolution: FileDepResolution,
	scopeRoot: string,
	ownsPath: (path: string) => boolean,
	seen: EdgeSeen,
): void {
	if (resolution.kind === "unresolved") return;
	if (resolution.kind === "external") {
		if (seen.external.has(resolution.id)) return;
		seen.external.add(resolution.id);
		edges.push({ kind: "external", from, id: resolution.id });
		return;
	}
	if (resolution.kind === "package") {
		if (!isWithin(scopeRoot, resolution.dir) || seen.package.has(resolution.dir)) return;
		seen.package.add(resolution.dir);
		edges.push({
			kind: "package",
			from,
			id: resolution.id,
			dir: resolution.dir,
			fileCount: resolution.fileCount,
		});
		return;
	}
	appendInternalPaths(edges, from, resolution.paths, scopeRoot, ownsPath, seen.internal);
}

function recordImporter(byTarget: Map<string, string[]>, target: string, from: string): void {
	const list = byTarget.get(target);
	if (list === undefined) byTarget.set(target, [from]);
	else if (!list.includes(from)) list.push(from);
}

type ForwardHitState = {
	hits: FileDepHit[];
	resultLimitReached: boolean;
	externalOmitted: number;
	inRepoCount: number;
	externalCount: number;
	listedInternal: Set<string>;
	listedPackage: Set<string>;
	listedExternal: Set<string>;
};

function pushForwardEdge(
	state: ForwardHitState,
	edge: FileGraphEdge,
	nextDepth: number,
	resultLimit: number,
	enqueue: (next: string) => void,
): boolean {
	if (edge.kind === "external") {
		if (state.listedExternal.has(edge.id)) return true;
		state.listedExternal.add(edge.id);
		if (state.externalCount >= EXTERNAL_HIT_LIMIT) {
			state.externalOmitted += 1;
			return true;
		}
		state.externalCount += 1;
		state.hits.push({ depth: nextDepth, kind: "external", id: edge.id });
		return true;
	}
	if (state.inRepoCount >= resultLimit) {
		state.resultLimitReached = true;
		return false;
	}
	if (edge.kind === "package") {
		if (state.listedPackage.has(edge.dir)) return true;
		state.listedPackage.add(edge.dir);
		state.inRepoCount += 1;
		state.hits.push({
			depth: nextDepth,
			kind: "package",
			id: edge.id,
			dir: edge.dir,
			fileCount: edge.fileCount,
		});
		return true;
	}
	if (state.listedInternal.has(edge.to)) return true;
	state.listedInternal.add(edge.to);
	state.inRepoCount += 1;
	state.hits.push({ depth: nextDepth, kind: "internal", path: edge.to });
	enqueue(edge.to);
	return true;
}

/** Breadth-first walk bounded by depth. `expand` returns false to stop the walk. */
async function walkDepth(
	seedPath: string,
	depth: number,
	signal: AbortSignal,
	expand: (path: string, nextDepth: number, enqueue: (next: string) => void) => Promise<boolean>,
): Promise<void> {
	const queue: { path: string; depth: number }[] = [{ path: seedPath, depth: 0 }];
	const visited = new Set<string>([seedPath]);
	while (queue.length > 0) {
		signal.throwIfAborted();
		const current = queue.shift();
		if (current === undefined) break;
		if (current.depth >= depth) continue;
		const nextDepth = current.depth + 1;
		const enqueue = (next: string): void => {
			if (nextDepth >= depth || visited.has(next)) return;
			visited.add(next);
			queue.push({ path: next, depth: nextDepth });
		};
		if (!(await expand(current.path, nextDepth, enqueue))) break;
	}
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
		const seen = emptyEdgeSeen();
		for (const imp of ir.imports) {
			signal.throwIfAborted();
			const resolution = await resolveFileDep(absolutePath, imp.specifier, host, signal);
			appendResolution(edges, absolutePath, resolution, scopeRoot, host.ownsPath, seen);
		}

		forwardCache.set(absolutePath, { contentHash: ir.contentHash, edges });
		return edges;
	};

	const indexForwardImporters = async (
		filePath: string,
		scopeRoot: string,
		byTarget: Map<string, string[]>,
		signal: AbortSignal,
	): Promise<void> => {
		const adapter = engine.registry.adapterForPath(filePath);
		if (adapter?.capabilities.fileDeps !== true || adapter.resolveFileDep === undefined) return;
		try {
			const edges = await loadForward(filePath, scopeRoot, signal);
			for (const edge of edges) {
				if (edge.kind === "internal") recordImporter(byTarget, edge.to, edge.from);
			}
		} catch {
			// Skip files that fail resolve/parse during reverse build; keep scanning.
		}
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
			await indexForwardImporters(step.value.ir.path, scopeRoot, byTarget, signal);
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
		const state: ForwardHitState = {
			hits: [],
			resultLimitReached: false,
			externalOmitted: 0,
			inRepoCount: 0,
			externalCount: 0,
			listedInternal: new Set(),
			listedPackage: new Set(),
			listedExternal: new Set(),
		};

		await walkDepth(seedPath, depth, signal, async (path, nextDepth, enqueue) => {
			const edges = await loadForward(path, scopeRoot, signal);
			for (const edge of edges) {
				if (!pushForwardEdge(state, edge, nextDepth, resultLimit, enqueue)) break;
			}
			return !state.resultLimitReached;
		});

		return {
			seedPath,
			depth,
			hits: state.hits,
			resultLimit,
			resultLimitReached: state.resultLimitReached,
			externalOmitted: state.externalOmitted,
		};
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

		await walkDepth(seedPath, depth, signal, async (path, nextDepth, enqueue) => {
			const importers = index.byTarget.get(path) ?? [];
			for (const importer of importers) {
				if (hits.length >= resultLimit) {
					resultLimitReached = true;
					break;
				}
				if (listed.has(importer)) continue;
				listed.add(importer);
				hits.push({ depth: nextDepth, kind: "internal", path: importer });
				enqueue(importer);
			}
			return !resultLimitReached;
		});

		return { seedPath, depth, hits, resultLimit, resultLimitReached, externalOmitted: 0 };
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
