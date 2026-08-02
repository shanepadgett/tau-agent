import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
	initializeTreeSitter,
	parse as astGrepParse,
	registerDynamicLanguage,
	type SgNode,
	type SgRoot,
} from "@ast-grep/wasm";
import { Language, Parser } from "web-tree-sitter";
import type { AdapterRegistry } from "./registry.ts";
import { createDefaultRegistry } from "./registry.ts";
import type { FileIr } from "./ir.ts";
import { grammarWasmPath, loadGrammarManifest, runtimeWasmPath, type GrammarPin } from "./grammars/manifest.ts";
import { formatPathForDisplay, pathResolutionError, resolveExplorePath } from "./traverse.ts";

export type FileSource = {
	ir: FileIr;
	/** Decoded source text this IR's offsets index into (UTF-16 code units). */
	source: string;
};

export type AstSearchBinding = {
	name: string;
	/** Exact matched text (single node or multi-node join of exact pieces). */
	text: string;
};

export type AstSearchHit = {
	/** 1-indexed inclusive. */
	startLine: number;
	endLine: number;
	/** Exact match preview (edit-grade). */
	text: string;
	bindings: AstSearchBinding[];
};

export type ExploreEngine = {
	/** Absolute session cwd — path resolution and directory scans use this. */
	readonly cwd: string;
	readonly registry: AdapterRegistry;
	/** Resolve path, read bytes, return cached or freshly extracted FileIr. */
	irForFile(path: string): Promise<FileIr>;
	/** One read: IR (cached when hash matches) plus the decoded source for slicing. */
	sourceForFile(path: string): Promise<FileSource>;
	/**
	 * Structural pattern search over one source string.
	 * Engine owns @ast-grep/wasm init + grammar registration from pinned wasm paths.
	 * Does not use the IR cache; does not cache match results.
	 */
	searchInSource(languageId: string, source: string, pattern: string): Promise<AstSearchHit[]>;
	invalidate(paths: readonly string[]): void;
	clear(): void;
	/**
	 * Drop IR cache and delete the retained Parser.
	 * Loaded Language modules are dropped from JS maps; web-tree-sitter 0.26 has no Language.delete().
	 */
	shutdown(): void;
};

export type ExploreEngineOptions = {
	cwd: string;
	registry?: AdapterRegistry;
};

type CacheEntry = {
	contentHash: string;
	ir: FileIr;
};

function contentHashOf(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function lineCountOf(source: string): number {
	if (source.length === 0) return 0;
	let count = 1;
	for (let i = 0; i < source.length; i += 1) {
		const code = source.charCodeAt(i);
		if (code === 10) count += 1;
		else if (code === 13) {
			count += 1;
			if (source.charCodeAt(i + 1) === 10) i += 1;
		}
	}
	return count;
}

function pinById(id: string): GrammarPin {
	const pin = loadGrammarManifest().grammars.find((entry) => entry.id === id);
	if (pin === undefined) {
		throw new Error(`No grammar artifact for language: ${id}`);
	}
	return pin;
}

function isMetaVarStart(c: string): boolean {
	return (c >= "A" && c <= "Z") || c === "_";
}

function isMetaVarContinue(c: string): boolean {
	return isMetaVarStart(c) || (c >= "0" && c <= "9");
}

function pushUniqueName(list: string[], name: string): void {
	if (!list.includes(name)) list.push(name);
}

/** Read `$NAME` / `$$$NAME` starting at `start` (must point at `$`). */
function readMetaVarAt(pattern: string, start: number): { dollars: number; name: string; next: number } {
	let i = start;
	let dollars = 0;
	while (i < pattern.length && pattern[i] === "$") {
		dollars += 1;
		i += 1;
	}
	let name = "";
	while (i < pattern.length) {
		const c = pattern[i];
		if (c === undefined) break;
		if ((name.length === 0 && isMetaVarStart(c)) || (name.length > 0 && isMetaVarContinue(c))) {
			name += c;
			i += 1;
			continue;
		}
		break;
	}
	return { dollars, name, next: i };
}

/** ast-grep metavars: `$NAME` one node, `$$$NAME` sibling sequence. Skip `$_`. */
function metaVarNames(pattern: string): { singles: string[]; multis: string[] } {
	const singles: string[] = [];
	const multis: string[] = [];
	let i = 0;
	while (i < pattern.length) {
		if (pattern[i] !== "$") {
			i += 1;
			continue;
		}
		const { dollars, name, next } = readMetaVarAt(pattern, i);
		i = next;
		if (name.length === 0 || name === "_") continue;
		if (dollars >= 3) pushUniqueName(multis, name);
		else if (dollars === 1) pushUniqueName(singles, name);
	}
	return { singles, multis };
}

function hitKey(hit: AstSearchHit): string {
	return `${hit.startLine}:${hit.endLine}:${hit.text}`;
}

/** @ast-grep/wasm Pos.index is Unicode scalar offset, not UTF-16. */
function sliceByCharOffset(source: string, startChar: number, endChar: number): string {
	let start = 0;
	let end = source.length;
	let charIndex = 0;
	for (let i = 0; i < source.length;) {
		if (charIndex === startChar) start = i;
		const code = source.charCodeAt(i);
		const step = code >= 0xd800 && code <= 0xdbff ? 2 : 1;
		i += step;
		charIndex += 1;
		if (charIndex === endChar) {
			end = i;
			break;
		}
	}
	if (charIndex < endChar) end = source.length;
	return source.slice(start, end);
}

function bindingsFromNode(node: SgNode, pattern: string, source: string): AstSearchBinding[] {
	const { singles, multis } = metaVarNames(pattern);
	const out: AstSearchBinding[] = [];
	for (const name of singles) {
		const match = node.getMatch(name);
		if (match !== undefined) out.push({ name, text: match.text() });
	}
	for (const name of multis) {
		const parts = node.getMultipleMatches(name);
		if (parts.length === 0) continue;
		const first = parts[0];
		const last = parts[parts.length - 1];
		if (first === undefined || last === undefined) continue;
		const start = first.range().start.index;
		const end = last.range().end.index;
		out.push({ name, text: sliceByCharOffset(source, start, end) });
	}
	return out;
}

function nodeToHit(node: SgNode, pattern: string, source: string): AstSearchHit {
	const range = node.range();
	return {
		startLine: range.start.line + 1,
		endLine: range.end.line + 1,
		text: node.text(),
		bindings: bindingsFromNode(node, pattern, source),
	};
}

function collectHits(
	root: SgRoot,
	matcher: unknown,
	pattern: string,
	source: string,
	into: Map<string, AstSearchHit>,
): void {
	const nodes = root.root().findAll(matcher);
	for (const node of nodes) {
		const hit = nodeToHit(node, pattern, source);
		const key = hitKey(hit);
		if (!into.has(key)) into.set(key, hit);
	}
}

/**
 * In-process web-tree-sitter host.
 * Parse → extract plain FileIr → tree.delete() immediately. Cache IR only.
 * All IR offsets are UTF-16 code units into the decoded source string.
 * Only this module resolves wasm paths via the grammar manifest.
 * ast_search uses @ast-grep/wasm on the same pinned grammar paths (decision 11-A).
 */
export function createExploreEngine(options: ExploreEngineOptions): ExploreEngine {
	const cwd = resolve(options.cwd);
	const registry = options.registry ?? createDefaultRegistry();
	const irCache = new Map<string, CacheEntry>();
	const languages = new Map<string, Language>();
	const languageLoads = new Map<string, Promise<Language>>();
	const searchLangReady = new Set<string>();

	let initPromise: Promise<void> | undefined;
	let searchInitPromise: Promise<void> | undefined;
	let parser: Parser | undefined;
	let shutDown = false;

	const assertLive = (): void => {
		if (shutDown) {
			throw new Error("Explore engine has been shut down");
		}
	};

	const requireSearchableAdapter = (languageId: string) => {
		const adapter = registry.adapterForId(languageId);
		if (adapter === undefined) {
			throw new Error(`Unregistered language: ${languageId}`);
		}
		if (adapter.mode !== "grammar" || !adapter.capabilities.search) {
			throw new Error(`Language does not support structural search: ${languageId}`);
		}
		return adapter;
	};

	const ensureReady = async (): Promise<Parser> => {
		assertLive();
		if (parser !== undefined) return parser;
		if (initPromise === undefined) {
			initPromise = Parser.init({ locateFile: () => runtimeWasmPath() }).then(() => {
				if (shutDown) return;
				parser = new Parser();
			});
		}
		await initPromise;
		assertLive();
		if (parser === undefined) throw new Error("Explore engine failed to initialize parser");
		return parser;
	};

	const ensureSearchReady = async (): Promise<void> => {
		assertLive();
		// IR path init first so locateFile pins web-tree-sitter.wasm for the process.
		await ensureReady();
		if (searchInitPromise === undefined) {
			searchInitPromise = initializeTreeSitter();
		}
		await searchInitPromise;
		assertLive();
	};

	const ensureSearchLanguage = async (languageId: string): Promise<void> => {
		assertLive();
		if (searchLangReady.has(languageId)) return;
		requireSearchableAdapter(languageId);
		await ensureSearchReady();
		assertLive();
		await registerDynamicLanguage({
			[languageId]: {
				libraryPath: grammarWasmPath(pinById(languageId)),
				expandoChar: "µ",
			},
		});
		assertLive();
		searchLangReady.add(languageId);
	};

	const loadLanguage = async (languageId: string): Promise<Language> => {
		assertLive();
		const cached = languages.get(languageId);
		if (cached !== undefined) return cached;

		let pending = languageLoads.get(languageId);
		if (pending === undefined) {
			pending = Language.load(grammarWasmPath(pinById(languageId))).then(
				(language) => {
					languageLoads.delete(languageId);
					if (!shutDown) {
						languages.set(languageId, language);
					}
					return language;
				},
				(error: unknown) => {
					languageLoads.delete(languageId);
					throw error;
				},
			);
			languageLoads.set(languageId, pending);
		}

		const language = await pending;
		assertLive();
		return language;
	};

	const buildIr = async (absolutePath: string, source: string, hash: string): Promise<FileIr> => {
		const adapter = registry.adapterForPath(absolutePath);
		if (adapter === undefined) {
			throw new Error(`Unsupported language for path: ${formatPathForDisplay(absolutePath, cwd)}`);
		}
		const lineCount = lineCountOf(source);

		if (adapter.mode === "source") {
			const extracted = adapter.extract(source);
			return {
				path: absolutePath,
				contentHash: hash,
				languageId: adapter.id,
				lineCount,
				decls: extracted.decls,
				imports: extracted.imports,
				fileCalls: extracted.fileCalls,
				parseDegraded: false,
			};
		}

		const activeParser = await ensureReady();
		const language = await loadLanguage(adapter.id);
		assertLive();
		activeParser.setLanguage(language);
		activeParser.reset();
		const tree = activeParser.parse(source);
		if (tree === null) {
			throw new Error(`Parse failed for ${formatPathForDisplay(absolutePath, cwd)}`);
		}
		try {
			const extracted = adapter.extract(tree, source);
			return {
				path: absolutePath,
				contentHash: hash,
				languageId: adapter.id,
				lineCount,
				decls: extracted.decls,
				imports: extracted.imports,
				fileCalls: extracted.fileCalls,
				parseDegraded: tree.rootNode.hasError,
			};
		} finally {
			tree.delete();
		}
	};

	const loadSource = async (path: string): Promise<FileSource> => {
		assertLive();
		const absolutePath = resolveExplorePath(cwd, path);
		let bytes: Buffer;
		try {
			bytes = await readFile(absolutePath);
		} catch (error) {
			throw pathResolutionError(error, path);
		}
		assertLive();
		const hash = contentHashOf(bytes);
		const source = bytes.toString("utf8");
		const cached = irCache.get(absolutePath);
		if (cached !== undefined && cached.contentHash === hash) {
			return { ir: cached.ir, source };
		}
		const ir = await buildIr(absolutePath, source, hash);
		assertLive();
		irCache.set(absolutePath, { contentHash: hash, ir });
		return { ir, source };
	};

	return {
		cwd,
		registry,

		async irForFile(path: string): Promise<FileIr> {
			const source = await loadSource(path);
			return source.ir;
		},

		async sourceForFile(path: string): Promise<FileSource> {
			return loadSource(path);
		},

		async searchInSource(languageId: string, source: string, pattern: string): Promise<AstSearchHit[]> {
			assertLive();
			const adapter = requireSearchableAdapter(languageId);
			await ensureSearchLanguage(languageId);
			assertLive();

			let root: SgRoot;
			try {
				root = astGrepParse(languageId, source);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				throw new Error(`Parse failed for structural search (${languageId}): ${message}`);
			}

			try {
				const byKey = new Map<string, AstSearchHit>();
				const matchers: unknown[] = [pattern];
				const contexts = adapter.patternContexts ?? [];
				for (const wrap of contexts) {
					if (!wrap.context.includes("$PATTERN")) continue;
					matchers.push({
						rule: {
							pattern: {
								context: wrap.context.split("$PATTERN").join(pattern),
								selector: wrap.selector,
							},
						},
					});
				}

				let anyMatcherOk = false;
				let lastError: string | undefined;
				for (const matcher of matchers) {
					try {
						collectHits(root, matcher, pattern, source, byKey);
						anyMatcherOk = true;
					} catch (error) {
						lastError = error instanceof Error ? error.message : String(error);
					}
				}
				if (!anyMatcherOk) {
					throw new Error(`Invalid pattern: ${lastError ?? "unknown pattern error"}`);
				}

				return [...byKey.values()].sort((a, b) => {
					if (a.startLine !== b.startLine) return a.startLine - b.startLine;
					if (a.endLine !== b.endLine) return a.endLine - b.endLine;
					return a.text.localeCompare(b.text);
				});
			} finally {
				root.free();
			}
		},

		invalidate(paths: readonly string[]): void {
			for (const path of paths) {
				irCache.delete(resolveExplorePath(cwd, path));
			}
		},

		clear(): void {
			irCache.clear();
		},

		shutdown(): void {
			if (shutDown) return;
			shutDown = true;
			irCache.clear();
			languages.clear();
			languageLoads.clear();
			searchLangReady.clear();
			parser?.delete();
			parser = undefined;
			initPromise = undefined;
			searchInitPromise = undefined;
		},
	};
}
