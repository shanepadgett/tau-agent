// fallow-ignore-file unused-file -- wired by 06-outline-show
import { readFile } from "node:fs/promises";
import type { ExploreEngine } from "./engine.ts";
import type { Decl, DeclKind, FileIr } from "./ir.ts";
import { findTargets } from "./query.ts";
import { scanIr } from "./scan.ts";
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
	| { kind: "resolved"; decl: Decl; path: string; ir: FileIr }
	| { kind: "candidates"; candidates: Candidate[] }
	| { kind: "notFound" };

/** Max candidates returned on ambiguity. Scan stops once this many matches are collected. */
const MAX_CANDIDATES = 10;

type Match = {
	decl: Decl;
	path: string;
	ir: FileIr;
};

function pathPresent(path: string | undefined): path is string {
	return path !== undefined && path.length > 0;
}

function toCandidate(match: Match, bytes: Uint8Array): Candidate {
	return {
		path: match.path,
		name: match.decl.name,
		qualifiedName: match.decl.qualifiedName,
		kind: match.decl.kind,
		startLine: match.decl.startLine,
		endLine: match.decl.endLine,
		signature: signatureText(match.decl, bytes),
	};
}

/**
 * Build candidate rows. Re-reads file bytes per path for signature slices.
 * Engine does not yet expose bytes alongside IR (task 06 will feel this too).
 */
async function candidatesFrom(matches: readonly Match[]): Promise<Candidate[]> {
	const bytesByPath = new Map<string, Uint8Array>();
	const out: Candidate[] = [];
	for (const match of matches) {
		if (out.length >= MAX_CANDIDATES) break;
		let bytes = bytesByPath.get(match.path);
		if (bytes === undefined) {
			bytes = await readFile(match.path);
			bytesByPath.set(match.path, bytes);
		}
		out.push(toCandidate(match, bytes));
	}
	return out;
}

function pushMatches(matches: Match[], ir: FileIr, name: string, line: number | undefined): void {
	for (const decl of findTargets(ir.decls, name, line)) {
		matches.push({ decl, path: ir.path, ir });
		if (matches.length >= MAX_CANDIDATES) return;
	}
}

/**
 * Resolve `{ path?, name, line? }` under `scopeDir` to one Decl, a bounded candidate
 * list, or notFound. Sole identity entry point for symbol-targeted tools.
 *
 * - `path` set → that file's IR only.
 * - `path` absent → budgeted `scanIr` of `scopeDir`.
 * - `line` set → keep decls whose inclusive `startLine..endLine` covers it.
 * - Multiple matches → candidates (never a silent pick). Zero → notFound.
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
		const ir = await engine.irForFile(target.path);
		signal.throwIfAborted();
		pushMatches(matches, ir, target.name, target.line);
	} else {
		const scan = scanIr({
			engine,
			cwd: engine.cwd,
			root: scopeDir,
			signal,
		});
		for await (const ir of scan) {
			signal.throwIfAborted();
			pushMatches(matches, ir, target.name, target.line);
			if (matches.length >= MAX_CANDIDATES) break;
		}
		// scan soft-stops on cancel; surface abort instead of partial resolution
		signal.throwIfAborted();
	}

	if (matches.length === 0) return { kind: "notFound" };

	const only = matches.length === 1 ? matches[0] : undefined;
	if (only !== undefined) {
		return { kind: "resolved", decl: only.decl, path: only.path, ir: only.ir };
	}

	return { kind: "candidates", candidates: await candidatesFrom(matches) };
}
