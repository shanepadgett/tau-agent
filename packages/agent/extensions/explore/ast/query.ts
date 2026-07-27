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

function nameMatches(decl: Decl, name: string): boolean {
	return decl.name === name || decl.qualifiedName === name;
}

function coversLine(decl: Decl, line: number): boolean {
	return line >= decl.startLine && line <= decl.endLine;
}

function findByName(decls: readonly Decl[], name: string): Decl[] {
	const out: Decl[] = [];
	walkDecls(decls, (decl) => {
		if (nameMatches(decl, name)) out.push(decl);
	});
	return out;
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
