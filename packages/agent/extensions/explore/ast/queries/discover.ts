import { lstat } from "node:fs/promises";
import type { ExploreEngine, FileSource } from "../engine.ts";
import type { Decl, DeclKind, Visibility } from "../ir.ts";
import { packageDeclKey, type PackageSurfaceHost } from "../package-surface.ts";
import { scanSources, type ScanOutcome } from "../scan.ts";
import { docsText, signatureText } from "../slice.ts";
import { pathResolutionError, resolveExplorePath } from "../../traverse.ts";

export type DiscoverSurface = "all" | "public" | "private" | "sourceExport" | "packageSurface";

export type DiscoverQuery =
	| { kind: "exactName"; name: string }
	| { kind: "prefixName"; name: string }
	| { kind: "substringName"; name: string }
	| { kind: "fuzzyName"; name: string; maxCandidates: number; maxWork: number }
	| { kind: "declarationKind"; declarationKind: DeclKind }
	| { kind: "documentation"; terms: string[]; maxCandidates: number; maxWork: number };

export type DiscoverCandidate = {
	path: string;
	name: string;
	qualifiedName: string;
	kind: DeclKind;
	startLine: number;
	endLine: number;
	signature: string;
	visibility: Visibility;
	exported: boolean;
	/** Import form when surface makes access the point. */
	access: string | undefined;
};

export type DiscoverResult = {
	candidates: DiscoverCandidate[];
	resultLimit: number;
	resultLimitReached: boolean;
	workLimitReached: boolean;
	candidateLimitReached: boolean;
	scan: ScanOutcome | undefined;
};

type ScoredCandidate = {
	score: number;
	candidate: DiscoverCandidate;
};

function nameTail(qualifiedName: string): string {
	const i = qualifiedName.lastIndexOf(".");
	return i === -1 ? qualifiedName : qualifiedName.slice(i + 1);
}

function nameFields(decl: Decl): [string, string] {
	return [decl.name, nameTail(decl.qualifiedName)];
}

function matchesNameQuery(kind: "exactName" | "prefixName" | "substringName", needle: string, decl: Decl): boolean {
	for (const field of nameFields(decl)) {
		if (kind === "exactName" && field === needle) return true;
		if (kind === "prefixName" && field.startsWith(needle)) return true;
		if (kind === "substringName" && field.includes(needle)) return true;
	}
	return false;
}

/** Lower is better. undefined = no match. */
function fuzzyScore(query: string, text: string): number | undefined {
	if (text.length === 0) return undefined;
	if (text === query) return 0;
	if (text.startsWith(query)) return 1;
	const idx = text.indexOf(query);
	if (idx >= 0) return 2 + idx + (text.length - query.length);

	let qi = 0;
	let gaps = 0;
	let last = -1;
	for (let i = 0; i < text.length && qi < query.length; i += 1) {
		if (text[i] === query[qi]) {
			if (last >= 0) gaps += i - last - 1;
			last = i;
			qi += 1;
		}
	}
	if (qi === query.length) return 100 + gaps + (text.length - query.length);

	const maxDist = Math.min(3, Math.max(1, Math.floor(query.length / 2)));
	const dist = boundedLevenshtein(query, text, maxDist);
	return dist === undefined ? undefined : 1000 + dist;
}

function boundedLevenshtein(a: string, b: string, maxDist: number): number | undefined {
	if (Math.abs(a.length - b.length) > maxDist) return undefined;
	const prev = Array.from({ length: b.length + 1 }, () => 0);
	const cur = Array.from({ length: b.length + 1 }, () => 0);
	for (let j = 0; j <= b.length; j += 1) prev[j] = j;
	for (let i = 1; i <= a.length; i += 1) {
		cur[0] = i;
		let rowMin = cur[0] ?? i;
		const ca = a.charCodeAt(i - 1);
		for (let j = 1; j <= b.length; j += 1) {
			const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
			const del = (prev[j] ?? maxDist + 1) + 1;
			const ins = (cur[j - 1] ?? maxDist + 1) + 1;
			const sub = (prev[j - 1] ?? maxDist + 1) + cost;
			const v = Math.min(del, ins, sub);
			cur[j] = v;
			if (v < rowMin) rowMin = v;
		}
		if (rowMin > maxDist) return undefined;
		for (let j = 0; j <= b.length; j += 1) prev[j] = cur[j] ?? 0;
	}
	const dist = prev[b.length] ?? maxDist + 1;
	return dist > maxDist ? undefined : dist;
}

function bestFuzzyScore(query: string, decl: Decl): number | undefined {
	let best: number | undefined;
	for (const field of nameFields(decl)) {
		const score = fuzzyScore(query, field);
		if (score === undefined) continue;
		if (best === undefined || score < best) best = score;
	}
	return best;
}

function isPublicSurface(decl: Decl, inExportedOwner: boolean): boolean {
	return decl.visibility === "public" && (decl.exported || inExportedOwner);
}

function matchesSurfaceFilter(
	surface: DiscoverSurface,
	path: string,
	decl: Decl,
	inExportedOwner: boolean,
	packageKeys: ReadonlySet<string> | undefined,
): boolean {
	switch (surface) {
		case "all":
			return true;
		case "public":
			return isPublicSurface(decl, inExportedOwner);
		case "private":
			return !isPublicSurface(decl, inExportedOwner);
		case "sourceExport":
			return decl.exported;
		case "packageSurface":
			return packageKeys !== undefined && packageKeys.has(packageDeclKey(path, decl));
	}
}

function toCandidate(path: string, decl: Decl, source: string, access: string | undefined): DiscoverCandidate {
	return {
		path,
		name: decl.name,
		qualifiedName: decl.qualifiedName,
		kind: decl.kind,
		startLine: decl.startLine,
		endLine: decl.endLine,
		signature: signatureText(decl, source).replace(/\s+$/u, ""),
		visibility: decl.visibility,
		exported: decl.exported,
		access,
	};
}

function accessFor(surface: DiscoverSurface, packageAccess: string | undefined): string | undefined {
	if (surface === "packageSurface") return packageAccess;
	return undefined;
}

function insertScored(heap: ScoredCandidate[], entry: ScoredCandidate, max: number): void {
	const at = heap.findIndex((row) => entry.score < row.score);
	if (at === -1) heap.push(entry);
	else heap.splice(at, 0, entry);
	if (heap.length > max) heap.length = max;
}

function compareCandidates(a: DiscoverCandidate, b: DiscoverCandidate): number {
	const byPath = a.path.localeCompare(b.path);
	if (byPath !== 0) return byPath;
	if (a.startLine !== b.startLine) return a.startLine - b.startLine;
	return a.qualifiedName.localeCompare(b.qualifiedName);
}

type MatchBucket = {
	plain: DiscoverCandidate[];
	scored: ScoredCandidate[];
	workUsed: number;
	workLimitReached: boolean;
	candidateLimitReached: boolean;
	scoring: boolean;
};

function newBucket(query: DiscoverQuery): MatchBucket {
	return {
		plain: [],
		scored: [],
		workUsed: 0,
		workLimitReached: false,
		candidateLimitReached: false,
		scoring: query.kind === "fuzzyName" || query.kind === "documentation",
	};
}

function considerDecl(
	bucket: MatchBucket,
	query: DiscoverQuery,
	path: string,
	decl: Decl,
	source: string,
	surface: DiscoverSurface,
	inExportedOwner: boolean,
	packageKeys: ReadonlySet<string> | undefined,
	packageAccess: ReadonlyMap<string, string> | undefined,
): void {
	if (bucket.workLimitReached) return;
	if (!matchesSurfaceFilter(surface, path, decl, inExportedOwner, packageKeys)) return;

	const id = packageDeclKey(path, decl);
	const access = accessFor(surface, packageAccess?.get(id));

	switch (query.kind) {
		case "exactName":
		case "prefixName":
		case "substringName": {
			if (!matchesNameQuery(query.kind, query.name, decl)) return;
			bucket.plain.push(toCandidate(path, decl, source, access));
			return;
		}
		case "declarationKind": {
			if (decl.kind !== query.declarationKind) return;
			bucket.plain.push(toCandidate(path, decl, source, access));
			return;
		}
		case "fuzzyName": {
			bucket.workUsed += 1;
			if (bucket.workUsed > query.maxWork) {
				bucket.workLimitReached = true;
				return;
			}
			const score = bestFuzzyScore(query.name, decl);
			if (score === undefined) return;
			const candidate = toCandidate(path, decl, source, access);
			const worst = bucket.scored[bucket.scored.length - 1];
			if (bucket.scored.length >= query.maxCandidates && worst !== undefined && score >= worst.score) {
				bucket.candidateLimitReached = true;
				return;
			}
			const before = bucket.scored.length;
			insertScored(bucket.scored, { score, candidate }, query.maxCandidates);
			if (before === query.maxCandidates) bucket.candidateLimitReached = true;
			return;
		}
		case "documentation": {
			if (decl.docStartOffset === undefined || decl.docEndOffset === undefined) return;
			bucket.workUsed += 1;
			if (bucket.workUsed > query.maxWork) {
				bucket.workLimitReached = true;
				return;
			}
			const docs = docsText(decl, source);
			if (docs === undefined || !query.terms.every((term) => docs.includes(term))) return;
			if (bucket.scored.length >= query.maxCandidates) {
				bucket.candidateLimitReached = true;
				return;
			}
			bucket.scored.push({ score: bucket.scored.length, candidate: toCandidate(path, decl, source, access) });
			if (bucket.scored.length >= query.maxCandidates) bucket.candidateLimitReached = true;
		}
	}
}

function walkFileDecls(
	bucket: MatchBucket,
	query: DiscoverQuery,
	file: FileSource,
	surface: DiscoverSurface,
	packageKeys: ReadonlySet<string> | undefined,
	packageAccess: ReadonlyMap<string, string> | undefined,
): void {
	const go = (decls: readonly Decl[], inExportedOwner: boolean): void => {
		for (const decl of decls) {
			if (bucket.workLimitReached) return;
			considerDecl(
				bucket,
				query,
				file.ir.path,
				decl,
				file.source,
				surface,
				inExportedOwner,
				packageKeys,
				packageAccess,
			);
			go(decl.children, inExportedOwner || decl.exported);
		}
	};
	go(file.ir.decls, false);
}

function finalizeBucket(bucket: MatchBucket, resultLimit: number): Omit<DiscoverResult, "scan"> {
	let ordered: DiscoverCandidate[];
	if (bucket.scoring) {
		const sorted = bucket.scored.slice().sort((a, b) => {
			if (a.score !== b.score) return a.score - b.score;
			return compareCandidates(a.candidate, b.candidate);
		});
		ordered = sorted.map((row) => row.candidate);
	} else {
		ordered = bucket.plain.slice().sort(compareCandidates);
	}
	return {
		candidates: ordered.slice(0, resultLimit),
		resultLimit,
		resultLimitReached: ordered.length > resultLimit,
		workLimitReached: bucket.workLimitReached,
		candidateLimitReached: bucket.candidateLimitReached,
	};
}

async function pathIsDirectory(absolutePath: string, input: string): Promise<void> {
	let stats;
	try {
		stats = await lstat(absolutePath);
	} catch (error) {
		throw pathResolutionError(error, input);
	}
	if (!stats.isDirectory()) throw new Error("discover requires a directory scope");
}

function packageSurfaceHost(engine: ExploreEngine): PackageSurfaceHost {
	return {
		cwd: engine.cwd,
		sourceForFile: (path) => engine.sourceForFile(path),
		ownsPath: (path) => {
			const adapter = engine.registry.adapterForPath(path);
			return adapter !== undefined && adapter.capabilities.packageSurface;
		},
	};
}

/** Directory-scoped declaration discovery. Language rules stay on adapters. */
export async function discover(
	engine: ExploreEngine,
	pathInput: string,
	query: DiscoverQuery,
	surface: DiscoverSurface,
	resultLimit: number,
	signal: AbortSignal,
): Promise<DiscoverResult> {
	signal.throwIfAborted();
	const absolutePath = resolveExplorePath(engine.cwd, pathInput);
	await pathIsDirectory(absolutePath, pathInput);

	const bucket = newBucket(query);

	if (surface === "packageSurface") {
		const resolvers = engine.registry.packageSurfaceResolvers();
		if (resolvers.length === 0) {
			throw new Error("packageSurface capability is not available");
		}
		const host = packageSurfaceHost(engine);
		const packageKeys = new Set<string>();
		const packageAccess = new Map<string, string>();
		const paths = new Set<string>();
		let filesVisited = 0;
		let anyPackage = false;

		for (const resolve of resolvers) {
			signal.throwIfAborted();
			const graph = await resolve(absolutePath, host, signal);
			if (graph === undefined) continue;
			anyPackage = true;
			filesVisited += graph.filesVisited;
			for (const key of graph.declKeys) packageKeys.add(key);
			for (const [key, access] of graph.accessByDecl) packageAccess.set(key, access);
			for (const path of graph.paths) paths.add(path);
		}

		if (!anyPackage) {
			throw new Error("packageSurface: no package found for a supporting language near the scope path");
		}

		for (const path of paths) {
			signal.throwIfAborted();
			if (bucket.workLimitReached) break;
			const file = await engine.sourceForFile(path);
			walkFileDecls(bucket, query, file, "packageSurface", packageKeys, packageAccess);
		}

		const finalized = finalizeBucket(bucket, resultLimit);
		return {
			...finalized,
			scan: {
				limit: undefined,
				filesVisited,
				sourceBytes: 0,
				elapsedMs: 0,
				filesEmitted: paths.size,
			},
		};
	}

	const scan = scanSources({ engine, cwd: engine.cwd, root: absolutePath, signal });
	let step = await scan.next();
	let filesEmitted = 0;
	while (!step.done) {
		signal.throwIfAborted();
		filesEmitted += 1;
		walkFileDecls(bucket, query, step.value, surface, undefined, undefined);
		if (bucket.workLimitReached) break;
		step = await scan.next();
	}
	if (signal.aborted) throw new Error("discover cancelled");
	const outcome: ScanOutcome = step.done
		? step.value
		: {
				limit: undefined,
				filesVisited: filesEmitted,
				sourceBytes: 0,
				elapsedMs: 0,
				filesEmitted,
			};
	if (outcome.limit === "cancelled") throw new Error("discover cancelled");

	const finalized = finalizeBucket(bucket, resultLimit);
	return { ...finalized, scan: outcome };
}
