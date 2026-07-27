import type { ExploreEngine } from "./engine.ts";
import type { Decl, DeclKind, FileIr } from "./ir.ts";
import { findTargets } from "./query.ts";
import { scanSources } from "./scan.ts";
import { signatureText } from "./slice.ts";

/** Symbol target — path and line optional; name required (may be dotted). */
export type Target = {
	path?: string;
	name: string;
	line?: number;
};

/** One ambiguous hit — signature is source byte slice, no body. */
export type Candidate = {
	path: string;
	name: string;
	qualifiedName: string;
	kind: DeclKind;
	startLine: number;
	endLine: number;
	signature: string;
};

export type Resolution =
	| { kind: "resolved"; decl: Decl; path: string; ir: FileIr; source: string }
	| { kind: "candidates"; candidates: Candidate[] }
	| { kind: "notFound" };

/** Max candidates returned on ambiguity. Scan stops once this many matches are collected. */
const MAX_CANDIDATES = 10;

type Match = {
	decl: Decl;
	path: string;
	ir: FileIr;
	source: string;
};

function pathPresent(path: string | undefined): path is string {
	return path !== undefined && path.length > 0;
}

function toCandidate(match: Match): Candidate {
	return {
		path: match.path,
		name: match.decl.name,
		qualifiedName: match.decl.qualifiedName,
		kind: match.decl.kind,
		startLine: match.decl.startLine,
		endLine: match.decl.endLine,
		signature: signatureText(match.decl, match.source),
	};
}

function pushMatches(matches: Match[], ir: FileIr, source: string, name: string, line: number | undefined): void {
	for (const decl of findTargets(ir.decls, name, line)) {
		matches.push({ decl, path: ir.path, ir, source });
		if (matches.length >= MAX_CANDIDATES) return;
	}
}

/**
 * Resolve `{ path?, name, line? }` under `scopeDir` to one Decl, a bounded candidate
 * list, or notFound. Sole identity entry point for symbol-targeted tools.
 *
 * - `path` set → that file's IR only.
 * - `path` absent → budgeted `scanSources` of `scopeDir`.
 * - `line` set → keep decls whose inclusive `startLine..endLine` covers it.
 * - Multiple matches → candidates (never a silent pick). Zero → notFound.
 * - Resolved carries the same bytes used to build the IR (no second skew window).
 */
export async function resolveTarget(
	engine: ExploreEngine,
	scopeDir: string,
	target: Target,
	signal: AbortSignal,
): Promise<Resolution> {
	signal.throwIfAborted();

	const matches: Match[] = [];

	if (pathPresent(target.path)) {
		const source = await engine.sourceForFile(target.path);
		signal.throwIfAborted();
		pushMatches(matches, source.ir, source.source, target.name, target.line);
	} else {
		const scan = scanSources({
			engine,
			cwd: engine.cwd,
			root: scopeDir,
			signal,
		});
		for await (const source of scan) {
			signal.throwIfAborted();
			pushMatches(matches, source.ir, source.source, target.name, target.line);
			if (matches.length >= MAX_CANDIDATES) break;
		}
		signal.throwIfAborted();
	}

	if (matches.length === 0) return { kind: "notFound" };

	const only = matches.length === 1 ? matches[0] : undefined;
	if (only !== undefined) {
		return {
			kind: "resolved",
			decl: only.decl,
			path: only.path,
			ir: only.ir,
			source: only.source,
		};
	}

	return {
		kind: "candidates",
		candidates: matches.slice(0, MAX_CANDIDATES).map(toCandidate),
	};
}
