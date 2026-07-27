import { lstat, readFile } from "node:fs/promises";
import type { AstSearchHit, ExploreEngine } from "../engine.ts";
import type { Decl, DeclKind, FileIr } from "../ir.ts";
import { walkDecls } from "../query.ts";
import { scanSources, type ScanOutcome } from "../scan.ts";
import { formatPathForDisplay, pathResolutionError, resolveExplorePath } from "../../traverse.ts";

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

function resolveLanguageId(
	engine: ExploreEngine,
	language: string | undefined,
	absolutePath: string | undefined,
	isDirectory: boolean,
): string {
	if (isDirectory) {
		if (language === undefined || language.length === 0) {
			throw new Error("language is required for directory targets");
		}
	}
	if (language !== undefined && language.length > 0) {
		const adapter = engine.registry.adapterForId(language);
		if (adapter === undefined) {
			throw new Error(`Unregistered language: ${language}`);
		}
		if (!adapter.capabilities.search) {
			throw new Error(`Language does not support structural search: ${language}`);
		}
		if (absolutePath !== undefined && !isDirectory) {
			const byPath = engine.registry.adapterForPath(absolutePath);
			if (byPath === undefined) {
				throw new Error(`Unsupported language for path: ${formatPathForDisplay(absolutePath, engine.cwd)}`);
			}
			if (byPath.id !== language) {
				throw new Error(`language mismatch: path is ${byPath.id}, requested ${language}`);
			}
		}
		return language;
	}
	if (absolutePath === undefined) {
		throw new Error("language is required");
	}
	const byPath = engine.registry.adapterForPath(absolutePath);
	if (byPath === undefined) {
		throw new Error(`Unsupported language for path: ${formatPathForDisplay(absolutePath, engine.cwd)}`);
	}
	if (!byPath.capabilities.search) {
		throw new Error(`Language does not support structural search: ${byPath.id}`);
	}
	return byPath.id;
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

	let hits: AstSearchHit[];
	try {
		hits = await engine.searchInSource(languageId, source, pattern);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		// Invalid pattern is global — rethrow.
		if (message.startsWith("Invalid pattern:")) throw error;
		return { matches: [], error: message };
	}

	let ir: FileIr | undefined;
	let parseDegraded = false;
	if (hits.length > 1) {
		try {
			const file = await engine.sourceForFile(absolutePath);
			ir = file.ir;
			parseDegraded = file.ir.parseDegraded;
		} catch {
			// Enclosing scope is best-effort.
		}
	} else if (hits.length === 1) {
		// Still surface parse uncertainty when IR is cheap via cache after sourceForFile.
		try {
			const file = await engine.sourceForFile(absolutePath);
			parseDegraded = file.ir.parseDegraded;
			// Single hit: only attach enclosing when degraded parse needs trust signal? Spec:
			// enclosing when disambiguating — single hit does not need it.
			ir = undefined;
		} catch {
			// ignore
		}
	}

	return {
		matches: attachEnclosing(absolutePath, hits, ir, parseDegraded, hits.length > 1),
		error: undefined,
	};
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

	const matches: AstSearchMatch[] = [];
	const fileErrors: { path: string; message: string }[] = [];
	let resultLimitReached = false;
	let scan: ScanOutcome | undefined;

	if (!isDirectory) {
		const one = await searchOneFile(engine, absolutePath, languageId, pattern, signal);
		if (one.error !== undefined) {
			throw new Error(one.error);
		}
		if (one.matches.length > resultLimit) {
			resultLimitReached = true;
			matches.push(...one.matches.slice(0, resultLimit));
		} else {
			matches.push(...one.matches);
		}
		return {
			matches,
			resultLimit,
			resultLimitReached,
			languageId,
			scan: undefined,
			fileErrors,
		};
	}

	// Directory: walk supported files; keep only the requested language.
	const generator = scanSources({
		engine,
		cwd: engine.cwd,
		root: absolutePath,
		signal,
		// scanSources already filters to registered languages; further filter below.
	});

	let step = await generator.next();
	while (!step.done) {
		signal.throwIfAborted();
		const file = step.value;
		if (file.ir.languageId !== languageId) {
			step = await generator.next();
			continue;
		}

		// Prefer source already loaded by scan (avoids second read for IR).
		let hits: AstSearchHit[];
		try {
			hits = await engine.searchInSource(languageId, file.source, pattern);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (message.startsWith("Invalid pattern:")) throw error;
			fileErrors.push({ path: file.ir.path, message });
			step = await generator.next();
			continue;
		}

		const room = resultLimit - matches.length;
		if (room <= 0) {
			if (hits.length > 0) resultLimitReached = true;
			// Still drain walk for budget outcome? Stop early for latency.
			break;
		}

		const limited = hits.length > room ? hits.slice(0, room) : hits;
		if (hits.length > room) resultLimitReached = true;

		const withScope = attachEnclosing(
			file.ir.path,
			limited,
			hits.length > 1 ? file.ir : undefined,
			file.ir.parseDegraded,
			hits.length > 1,
		);
		matches.push(...withScope);

		if (matches.length >= resultLimit) {
			resultLimitReached = true;
			break;
		}
		step = await generator.next();
	}

	if (signal.aborted) throw new Error("ast_search cancelled");

	if (step.done) {
		scan = step.value;
	} else {
		scan = {
			limit: undefined,
			filesVisited: 0,
			sourceBytes: 0,
			elapsedMs: 0,
			filesEmitted: matches.length > 0 ? 1 : 0,
		};
	}
	if (scan.limit === "cancelled") throw new Error("ast_search cancelled");

	return {
		matches,
		resultLimit,
		resultLimitReached,
		languageId,
		scan,
		fileErrors,
	};
}
