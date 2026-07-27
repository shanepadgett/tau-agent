import type { Decl } from "./ir.ts";
import type { FileSource } from "./engine.ts";

/** Stable key for a declaration on a package surface (path + identity spans). */
export function packageDeclKey(path: string, decl: Decl): string {
	return `${path}\0${decl.qualifiedName}\0${decl.startLine}\0${decl.startOffset}`;
}

/**
 * Host services for a package-surface resolver.
 * Language-agnostic: resolvers never touch the engine type.
 */
export type PackageSurfaceHost = {
	readonly cwd: string;
	sourceForFile(path: string): Promise<FileSource>;
	/** True when path belongs to a language that participates in this surface capability. */
	ownsPath(path: string): boolean;
};

/**
 * Resolved public package surface for one language family.
 * Discover matches ordinary IR decls against `declKeys` — no language branches.
 */
export type PackageSurfaceGraph = {
	declKeys: ReadonlySet<string>;
	/** packageDeclKey → caller import/access line when known. */
	accessByDecl: ReadonlyMap<string, string>;
	/** Absolute defining files that hold surface decls. */
	paths: readonly string[];
	filesVisited: number;
};

/**
 * Language-owned package surface resolution.
 * `undefined` = this language has no package root at the scope (try next resolver).
 * Throw only for hard failures (broken manifest, etc.).
 */
export type PackageSurfaceResolver = (
	scopeRoot: string,
	host: PackageSurfaceHost,
	signal: AbortSignal,
) => Promise<PackageSurfaceGraph | undefined>;
