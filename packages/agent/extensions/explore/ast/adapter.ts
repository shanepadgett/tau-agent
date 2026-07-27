import type { Tree } from "web-tree-sitter";
import type { Decl, ImportRef } from "./ir.ts";
import type { PackageSurfaceResolver } from "./package-surface.ts";

export type LanguageCapabilities = {
	shape: boolean;
	search: boolean;
	fileDeps: boolean;
	callEdges: boolean;
	packageSurface: boolean;
};

export type ExtractResult = {
	decls: Decl[];
	imports: ImportRef[];
};

/** Result of adapter-owned import specifier → file resolution. */
export type FileDepResolution =
	| { kind: "internal"; paths: string[] }
	| { kind: "external"; id: string }
	| { kind: "unresolved" };

/**
 * Host services for file-dep resolution.
 * Language-agnostic: resolvers never touch the engine type.
 */
export type FileDepHost = {
	readonly cwd: string;
	/** Scope root for this query. Resolvers must not walk above it for internal hits. */
	readonly scopeRoot: string;
	pathExists(path: string): Promise<boolean>;
	isFile(path: string): Promise<boolean>;
	/** Basenames; empty if missing or not a directory. */
	readDir(path: string): Promise<string[]>;
	/** True when path is a registered source file this graph should consider. */
	ownsPath(path: string): boolean;
	/** Session-scoped memo bag; cleared with graph invalidation. */
	readonly memo: Map<string, unknown>;
};

export type FileDepResolver = (
	fromPath: string,
	specifier: string,
	host: FileDepHost,
	signal: AbortSignal,
) => Promise<FileDepResolution>;

/**
 * Grammar-backed language. `id` must match a pin in `ast/grammars/manifest`.
 * Engine owns wasm load/parse; adapter only walks the tree.
 * Language-owned hooks (`importNoiseIdentifiers`, `resolveFileDep`, optional `resolvePackageSurface`, callEdges)
 * stay on the adapter — tools/queries never branch on language id.
 */
export type GrammarAdapter = {
	readonly mode: "grammar";
	readonly id: string;
	readonly extensions: readonly string[];
	readonly capabilities: LanguageCapabilities;
	/** Keywords/types ignored when intersecting import text with a declaration slice (`show`). */
	readonly importNoiseIdentifiers: ReadonlySet<string>;
	extract(tree: Tree, source: string): ExtractResult;
	/** Required when `capabilities.fileDeps` is true. */
	readonly resolveFileDep?: FileDepResolver;
	readonly resolvePackageSurface?: PackageSurfaceResolver;
};

/**
 * Source-only language (Markdown). No tree-sitter grammar.
 * Discriminant keeps engine free of `language ===` branches.
 */
export type SourceAdapter = {
	readonly mode: "source";
	readonly id: string;
	readonly extensions: readonly string[];
	readonly capabilities: LanguageCapabilities;
	readonly importNoiseIdentifiers: ReadonlySet<string>;
	extract(source: string): ExtractResult;
	readonly resolveFileDep?: FileDepResolver;
	readonly resolvePackageSurface?: PackageSurfaceResolver;
};

export type LanguageAdapter = GrammarAdapter | SourceAdapter;
