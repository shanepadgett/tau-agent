import { lstat, readFile } from "node:fs/promises";
import type { AstSearchHit, ExploreEngine, FileSource } from "../engine.ts";
import type { Decl, DeclKind, FileIr } from "../ir.ts";
import { walkDecls } from "../query.ts";
import { scanSources, type ScanOutcome } from "../scan.ts";
import { formatPathForDisplay, pathResolutionError, resolveExplorePath } from "../traverse.ts";

const PATTERN_MAX_BYTES = 16 * 1024;

export type AstSearchMatch = AstSearchHit & {
	path: string;
	/** Innermost enclosing decl when it helps disambiguate multi-hit files. */
	enclosing: { name: string; kind: DeclKind; startLine: number } | undefined;
	parseDegraded: boolean;
};

export type AstSearchResult = {
	matches: AstSearchMatch[];
	resultLimit: number;
	resultLimitReached: boolean;
	languageId: string;
	scan: ScanOutcome | undefined;
	/** Files that failed to search (path + reason). */
	fileErrors: { path: string; message: string }[];
};

function assertPattern(pattern: string): void {
	if (pattern.length === 0) throw new Error("pattern must be non-empty");
	const bytes = Buffer.byteLength(pattern, "utf8");
	if (bytes > PATTERN_MAX_BYTES) {
		throw new Error(`pattern exceeds ${PATTERN_MAX_BYTES} bytes (${bytes})`);
	}
}

function requireSearchSupport(supportsSearch: boolean, label: string): void {
	if (!supportsSearch) {
		throw new Error(`Language does not support structural search: ${label}`);
	}
}

function pathLanguageId(engine: ExploreEngine, absolutePath: string): string {
	const byPath = engine.registry.adapterForPath(absolutePath);
	if (byPath === undefined) {
		throw new Error(`Unsupported language for path: ${formatPathForDisplay(absolutePath, engine.cwd)}`);
	}
	return byPath.id;
}

function resolveLanguageId(
	engine: ExploreEngine,
	language: string | undefined,
	absolutePath: string | undefined,
	isDirectory: boolean,
): string {
	if (isDirectory && (language === undefined || language.length === 0)) {
		throw new Error("language is required for directory targets");
	}
	if (language !== undefined && language.length > 0) {
		const adapter = engine.registry.adapterForId(language);
		if (adapter === undefined) {
			throw new Error(`Unregistered language: ${language}`);
		}
		requireSearchSupport(adapter.capabilities.search, language);
		if (absolutePath !== undefined && !isDirectory) {
			const pathId = pathLanguageId(engine, absolutePath);
			if (pathId !== language) {
				throw new Error(`language mismatch: path is ${pathId}, requested ${language}`);
			}
		}
		return language;
	}
	if (absolutePath === undefined) {
		throw new Error("language is required");
	}
	const pathId = pathLanguageId(engine, absolutePath);
	const adapter = engine.registry.adapterForId(pathId);
	requireSearchSupport(adapter?.capabilities.search === true, pathId);
	return pathId;
}

function innermostEnclosing(
	ir: FileIr,
	startLine: number,
	endLine: number,
): { name: string; kind: DeclKind; startLine: number } | undefined {
	let best: Decl | undefined;
	walkDecls(ir.decls, (decl) => {
		if (decl.startLine <= startLine && decl.endLine >= endLine) {
			// Prefer strictly containing named scopes over the match's own span when equal.
			if (
				best === undefined ||
				decl.startLine > best.startLine ||
				(decl.startLine === best.startLine && decl.endLine < best.endLine)
			) {
				best = decl;
			}
		}
	});
	if (best === undefined) return undefined;
	// Skip file-level module/package wrappers that don't disambiguate.
	if (best.kind === "module" || best.kind === "package") return undefined;
	// If the match is the whole decl body span, scope adds little.
	if (best.startLine === startLine && best.endLine === endLine) return undefined;
	return { name: best.name, kind: best.kind, startLine: best.startLine };
}

function attachEnclosing(
	path: string,
	hits: readonly AstSearchHit[],
	ir: FileIr | undefined,
	parseDegraded: boolean,
	disambiguate: boolean,
): AstSearchMatch[] {
	return hits.map((hit) => ({
		...hit,
		path,
		parseDegraded,
		enclosing: disambiguate && ir !== undefined ? innermostEnclosing(ir, hit.startLine, hit.endLine) : undefined,
	}));
}

async function loadHitMeta(
	engine: ExploreEngine,
	absolutePath: string,
	hitCount: number,
): Promise<{ ir: FileIr | undefined; parseDegraded: boolean }> {
	if (hitCount === 0) return { ir: undefined, parseDegraded: false };
	try {
		const file = await engine.sourceForFile(absolutePath);
		// Multi-hit files get enclosing scopes; single hits only need parseDegraded.
		return {
			ir: hitCount > 1 ? file.ir : undefined,
			parseDegraded: file.ir.parseDegraded,
		};
	} catch {
		return { ir: undefined, parseDegraded: false };
	}
}

async function searchHitsInSource(
	engine: ExploreEngine,
	languageId: string,
	source: string,
	pattern: string,
): Promise<{ hits: AstSearchHit[]; error: string | undefined }> {
	try {
		return { hits: await engine.searchInSource(languageId, source, pattern), error: undefined };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		// Invalid pattern is global — rethrow.
		if (message.startsWith("Invalid pattern:")) throw error;
		return { hits: [], error: message };
	}
}

async function searchOneFile(
	engine: ExploreEngine,
	absolutePath: string,
	languageId: string,
	pattern: string,
	signal: AbortSignal,
): Promise<{ matches: AstSearchMatch[]; error: string | undefined }> {
	signal.throwIfAborted();
	let source: string;
	try {
		const bytes = await readFile(absolutePath);
		source = bytes.toString("utf8");
	} catch (error) {
		return { matches: [], error: pathResolutionError(error, absolutePath).message };
	}
	signal.throwIfAborted();

	const searched = await searchHitsInSource(engine, languageId, source, pattern);
	if (searched.error !== undefined) return { matches: [], error: searched.error };

	const meta = await loadHitMeta(engine, absolutePath, searched.hits.length);
	return {
		matches: attachEnclosing(absolutePath, searched.hits, meta.ir, meta.parseDegraded, searched.hits.length > 1),
		error: undefined,
	};
}

type DirectorySearchState = {
	matches: AstSearchMatch[];
	fileErrors: { path: string; message: string }[];
	resultLimitReached: boolean;
	scan: ScanOutcome | undefined;
};

/** `stop` means the walk should end after this file. */
function absorbDirectoryHits(
	state: DirectorySearchState,
	path: string,
	hits: readonly AstSearchHit[],
	ir: FileIr,
	resultLimit: number,
): "continue" | "stop" {
	const room = resultLimit - state.matches.length;
	if (room <= 0) {
		if (hits.length > 0) state.resultLimitReached = true;
		return "stop";
	}
	const limited = hits.length > room ? hits.slice(0, room) : hits;
	if (hits.length > room) state.resultLimitReached = true;
	state.matches.push(
		...attachEnclosing(path, limited, hits.length > 1 ? ir : undefined, ir.parseDegraded, hits.length > 1),
	);
	if (state.matches.length >= resultLimit) {
		state.resultLimitReached = true;
		return "stop";
	}
	return "continue";
}

function scanOutcomeFromStep(step: IteratorResult<FileSource, ScanOutcome>, matchCount: number): ScanOutcome {
	if (step.done) return step.value;
	return {
		limit: undefined,
		filesVisited: 0,
		sourceBytes: 0,
		elapsedMs: 0,
		filesEmitted: matchCount > 0 ? 1 : 0,
	};
}

async function searchDirectory(
	engine: ExploreEngine,
	absolutePath: string,
	languageId: string,
	pattern: string,
	resultLimit: number,
	signal: AbortSignal,
): Promise<DirectorySearchState> {
	const state: DirectorySearchState = {
		matches: [],
		fileErrors: [],
		resultLimitReached: false,
		scan: undefined,
	};

	const generator = scanSources({
		engine,
		cwd: engine.cwd,
		root: absolutePath,
		signal,
	});

	let step = await generator.next();
	while (!step.done) {
		signal.throwIfAborted();
		const file = step.value;
		if (file.ir.languageId !== languageId) {
			step = await generator.next();
			continue;
		}

		const searched = await searchHitsInSource(engine, languageId, file.source, pattern);
		if (searched.error !== undefined) {
			state.fileErrors.push({ path: file.ir.path, message: searched.error });
			step = await generator.next();
			continue;
		}

		if (absorbDirectoryHits(state, file.ir.path, searched.hits, file.ir, resultLimit) === "stop") break;
		step = await generator.next();
	}

	if (signal.aborted) throw new Error("ast_search cancelled");
	const scan = scanOutcomeFromStep(step, state.matches.length);
	if (scan.limit === "cancelled") throw new Error("ast_search cancelled");
	state.scan = scan;
	return state;
}

/**
 * Structural pattern search on one file or a language-filtered directory walk.
 * Matcher and grammar lifecycle live on the engine; this query only walks and shapes.
 */
export async function astSearch(
	engine: ExploreEngine,
	pathInput: string,
	pattern: string,
	language: string | undefined,
	resultLimit: number,
	signal: AbortSignal,
): Promise<AstSearchResult> {
	signal.throwIfAborted();
	assertPattern(pattern);

	const absolutePath = resolveExplorePath(engine.cwd, pathInput);
	let stats;
	try {
		stats = await lstat(absolutePath);
	} catch (error) {
		throw pathResolutionError(error, pathInput);
	}

	const isDirectory = stats.isDirectory();
	const languageId = resolveLanguageId(engine, language, isDirectory ? undefined : absolutePath, isDirectory);

	if (!isDirectory) {
		const one = await searchOneFile(engine, absolutePath, languageId, pattern, signal);
		if (one.error !== undefined) throw new Error(one.error);
		const truncated = one.matches.length > resultLimit;
		return {
			matches: truncated ? one.matches.slice(0, resultLimit) : one.matches,
			resultLimit,
			resultLimitReached: truncated,
			languageId,
			scan: undefined,
			fileErrors: [],
		};
	}

	const directory = await searchDirectory(engine, absolutePath, languageId, pattern, resultLimit, signal);
	return {
		matches: directory.matches,
		resultLimit,
		resultLimitReached: directory.resultLimitReached,
		languageId,
		scan: directory.scan,
		fileErrors: directory.fileErrors,
	};
}
