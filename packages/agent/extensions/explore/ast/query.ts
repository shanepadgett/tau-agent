// fallow-ignore-file unused-file -- wired by 05-identity-resolution
import type { Decl } from "./ir.ts";

/** Depth-first visit of a decl forest. */
export function walkDecls(decls: readonly Decl[], visit: (decl: Decl, depth: number) => void): void {
	const go = (nodes: readonly Decl[], depth: number): void => {
		for (const decl of nodes) {
			visit(decl, depth);
			if (decl.children.length > 0) go(decl.children, depth + 1);
		}
	};
	go(decls, 0);
}

/** Flat list, parents before children. */
export function flattenDecls(decls: readonly Decl[]): Decl[] {
	const out: Decl[] = [];
	walkDecls(decls, (decl) => {
		out.push(decl);
	});
	return out;
}

/** `name` matches bare `decl.name` or full `decl.qualifiedName`. */
export function nameMatches(decl: Decl, name: string): boolean {
	return decl.name === name || decl.qualifiedName === name;
}

/** Inclusive 1-indexed line coverage (identity rule). */
export function coversLine(decl: Decl, line: number): boolean {
	return line >= decl.startLine && line <= decl.endLine;
}

/** All decls (nested) matching predicate. */
export function findDecls(decls: readonly Decl[], predicate: (decl: Decl) => boolean): Decl[] {
	const out: Decl[] = [];
	walkDecls(decls, (decl) => {
		if (predicate(decl)) out.push(decl);
	});
	return out;
}

export function findByName(decls: readonly Decl[], name: string): Decl[] {
	return findDecls(decls, (decl) => nameMatches(decl, name));
}

/** Name matches, then optional line filter. */
export function findTargets(decls: readonly Decl[], name: string, line?: number): Decl[] {
	const named = findByName(decls, name);
	if (line === undefined) return named;
	return named.filter((decl) => coversLine(decl, line));
}

/** Drop private/internal decls from a forest; keep structure. */
export function filterDeclForest(decls: readonly Decl[], keep: (decl: Decl) => boolean): Decl[] {
	const out: Decl[] = [];
	for (const decl of decls) {
		if (!keep(decl)) continue;
		out.push({
			...decl,
			children: filterDeclForest(decl.children, keep),
		});
	}
	return out;
}
