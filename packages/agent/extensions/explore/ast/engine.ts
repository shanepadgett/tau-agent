// fallow-ignore-file unused-file,unused-export -- wired by 06-outline-show
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Language, Parser } from "web-tree-sitter";
import type { AdapterRegistry } from "./registry.ts";
import { createDefaultRegistry } from "./registry.ts";
import type { ExtractResult } from "./adapter.ts";
import type { Decl, FileIr } from "./ir.ts";
import { grammarWasmPath, loadGrammarManifest, runtimeWasmPath, type GrammarPin } from "./grammars/manifest.ts";
import { formatPathForDisplay, pathResolutionError, resolveExplorePath } from "../traverse.ts";

export type ExploreEngine = {
	/** Absolute session cwd — path resolution and directory scans use this. */
	readonly cwd: string;
	readonly registry: AdapterRegistry;
	/** Resolve path, read bytes, return cached or freshly extracted FileIr. */
	irForFile(path: string): Promise<FileIr>;
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

/**
 * web-tree-sitter indexes JS strings in UTF-16 code units, not UTF-8 bytes.
 * FileIr stores UTF-8 byte offsets into file bytes — convert once at the grammar boundary.
 * Source adapters (Markdown) already emit UTF-8 and must not pass through this.
 */
function makeJsToUtf8Mapper(source: string): (jsOffset: number) => number {
	const map = new Uint32Array(source.length + 1);
	let byte = 0;
	let i = 0;
	while (i < source.length) {
		map[i] = byte;
		const code = source.charCodeAt(i);
		if (code < 0x80) {
			byte += 1;
			i += 1;
		} else if (code < 0x800) {
			byte += 2;
			i += 1;
		} else if (code >= 0xd800 && code <= 0xdbff && i + 1 < source.length) {
			const low = source.charCodeAt(i + 1);
			if (low >= 0xdc00 && low <= 0xdfff) {
				map[i + 1] = byte;
				byte += 4;
				i += 2;
				continue;
			}
			byte += 3;
			i += 1;
		} else {
			byte += 3;
			i += 1;
		}
	}
	map[source.length] = byte;
	return (jsOffset: number): number => {
		if (jsOffset <= 0) return 0;
		if (jsOffset >= source.length) return byte;
		return map[jsOffset] ?? byte;
	};
}

function remapDeclToUtf8(decl: Decl, toUtf8: (jsOffset: number) => number): Decl {
	const next: Decl = {
		...decl,
		startByte: toUtf8(decl.startByte),
		endByte: toUtf8(decl.endByte),
		signatureEndByte: toUtf8(decl.signatureEndByte),
		children: decl.children.map((child) => remapDeclToUtf8(child, toUtf8)),
	};
	if (decl.bodyStartByte !== undefined) next.bodyStartByte = toUtf8(decl.bodyStartByte);
	if (decl.bodyEndByte !== undefined) next.bodyEndByte = toUtf8(decl.bodyEndByte);
	if (decl.docStartByte !== undefined) next.docStartByte = toUtf8(decl.docStartByte);
	if (decl.docEndByte !== undefined) next.docEndByte = toUtf8(decl.docEndByte);
	return next;
}

function remapExtractToUtf8(extracted: ExtractResult, source: string): ExtractResult {
	const toUtf8 = makeJsToUtf8Mapper(source);
	return {
		decls: extracted.decls.map((decl) => remapDeclToUtf8(decl, toUtf8)),
		imports: extracted.imports,
	};
}

/**
 * In-process web-tree-sitter host.
 * Parse → extract plain FileIr → tree.delete() immediately. Cache IR only.
 * Only this module resolves wasm paths via the grammar manifest.
 */
export function createExploreEngine(options: ExploreEngineOptions): ExploreEngine {
	const cwd = resolve(options.cwd);
	const registry = options.registry ?? createDefaultRegistry();
	const irCache = new Map<string, CacheEntry>();
	const languages = new Map<string, Language>();
	const languageLoads = new Map<string, Promise<Language>>();

	let initPromise: Promise<void> | undefined;
	let parser: Parser | undefined;
	let shutDown = false;
	let generation = 0;

	const assertLive = (gen: number): void => {
		if (shutDown || generation !== gen) {
			throw new Error("Explore engine has been shut down");
		}
	};

	const ensureReady = async (): Promise<Parser> => {
		assertLive(generation);
		if (parser !== undefined) return parser;
		const gen = generation;
		if (initPromise === undefined) {
			initPromise = Parser.init({ locateFile: () => runtimeWasmPath() }).then(() => {
				if (shutDown || generation !== gen) return;
				parser = new Parser();
			});
		}
		await initPromise;
		assertLive(gen);
		if (parser === undefined) throw new Error("Explore engine failed to initialize parser");
		return parser;
	};

	const loadLanguage = async (languageId: string): Promise<Language> => {
		assertLive(generation);
		const cached = languages.get(languageId);
		if (cached !== undefined) return cached;

		const gen = generation;
		let pending = languageLoads.get(languageId);
		if (pending === undefined) {
			pending = Language.load(grammarWasmPath(pinById(languageId))).then(
				(language) => {
					languageLoads.delete(languageId);
					if (!shutDown && generation === gen) {
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
		assertLive(gen);
		return language;
	};

	const buildIr = async (absolutePath: string, bytes: Buffer, hash: string): Promise<FileIr> => {
		const adapter = registry.adapterForPath(absolutePath);
		if (adapter === undefined) {
			throw new Error(`Unsupported language for path: ${formatPathForDisplay(absolutePath, cwd)}`);
		}
		const source = bytes.toString("utf8");
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
				parseDegraded: false,
			};
		}

		const gen = generation;
		const activeParser = await ensureReady();
		const language = await loadLanguage(adapter.id);
		assertLive(gen);
		activeParser.setLanguage(language);
		activeParser.reset();
		const tree = activeParser.parse(source);
		if (tree === null) {
			throw new Error(`Parse failed for ${formatPathForDisplay(absolutePath, cwd)}`);
		}
		try {
			const extracted = remapExtractToUtf8(adapter.extract(tree, source), source);
			return {
				path: absolutePath,
				contentHash: hash,
				languageId: adapter.id,
				lineCount,
				decls: extracted.decls,
				imports: extracted.imports,
				parseDegraded: tree.rootNode.hasError,
			};
		} finally {
			tree.delete();
		}
	};

	return {
		cwd,
		registry,

		async irForFile(path: string): Promise<FileIr> {
			const gen = generation;
			assertLive(gen);
			const absolutePath = resolveExplorePath(cwd, path);
			let bytes: Buffer;
			try {
				bytes = await readFile(absolutePath);
			} catch (error) {
				throw pathResolutionError(error, path);
			}
			assertLive(gen);
			const hash = contentHashOf(bytes);
			const cached = irCache.get(absolutePath);
			if (cached !== undefined && cached.contentHash === hash) {
				return cached.ir;
			}
			const ir = await buildIr(absolutePath, bytes, hash);
			assertLive(gen);
			irCache.set(absolutePath, { contentHash: hash, ir });
			return ir;
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
			generation += 1;
			irCache.clear();
			languages.clear();
			languageLoads.clear();
			parser?.delete();
			parser = undefined;
			initPromise = undefined;
		},
	};
}
