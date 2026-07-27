import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Language, Parser } from "web-tree-sitter";
import type { AdapterRegistry } from "./registry.ts";
import { createDefaultRegistry } from "./registry.ts";
import type { FileIr } from "./ir.ts";
import { grammarWasmPath, loadGrammarManifest, runtimeWasmPath, type GrammarPin } from "./grammars/manifest.ts";
import { formatPathForDisplay, pathResolutionError, resolveExplorePath } from "../traverse.ts";

export type FileSource = {
	ir: FileIr;
	/** Decoded source text this IR's offsets index into (UTF-16 code units). */
	source: string;
};

export type ExploreEngine = {
	/** Absolute session cwd — path resolution and directory scans use this. */
	readonly cwd: string;
	readonly registry: AdapterRegistry;
	/** Resolve path, read bytes, return cached or freshly extracted FileIr. */
	irForFile(path: string): Promise<FileIr>;
	/** One read: IR (cached when hash matches) plus the decoded source for slicing. */
	sourceForFile(path: string): Promise<FileSource>;
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
 * In-process web-tree-sitter host.
 * Parse → extract plain FileIr → tree.delete() immediately. Cache IR only.
 * All IR offsets are UTF-16 code units into the decoded source string.
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
			const extracted = adapter.extract(tree, source);
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

	const loadSource = async (path: string): Promise<FileSource> => {
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
		const source = bytes.toString("utf8");
		const cached = irCache.get(absolutePath);
		if (cached !== undefined && cached.contentHash === hash) {
			return { ir: cached.ir, source };
		}
		const ir = await buildIr(absolutePath, source, hash);
		assertLive(gen);
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
