// fallow-ignore-file unused-file,unused-type -- wired by 06-outline-show
import type { Tree } from "web-tree-sitter";
import type { Decl, ImportRef } from "./ir.ts";

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
 */
export type GrammarAdapter = {
	readonly mode: "grammar";
	readonly id: string;
	readonly extensions: readonly string[];
	readonly capabilities: LanguageCapabilities;
	extract(tree: Tree, source: string): ExtractResult;
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
	extract(source: string): ExtractResult;
};

export type LanguageAdapter = GrammarAdapter | SourceAdapter;
