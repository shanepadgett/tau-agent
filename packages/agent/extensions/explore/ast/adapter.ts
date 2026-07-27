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

/**
 * Grammar-backed language. `id` must match a pin in `ast/grammars/manifest`.
 * Engine owns wasm load/parse; adapter only walks the tree.
 * Language-owned hooks (`importNoiseIdentifiers`, optional `resolvePackageSurface`, later fileDeps/callEdges)
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
	readonly resolvePackageSurface?: PackageSurfaceResolver;
};

export type LanguageAdapter = GrammarAdapter | SourceAdapter;
