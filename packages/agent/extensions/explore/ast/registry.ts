import { extname } from "node:path";
import type { LanguageAdapter, LanguageCapabilities } from "./adapter.ts";
import { csharpAdapter } from "./languages/csharp.ts";
import { goAdapter } from "./languages/go.ts";
import { javaAdapter } from "./languages/java.ts";
import { kotlinAdapter } from "./languages/kotlin.ts";
import { odinAdapter } from "./languages/odin.ts";
import { rustAdapter } from "./languages/rust.ts";
import { swiftAdapter } from "./languages/swift.ts";
import { tsxAdapter, typescriptAdapter } from "./languages/typescript.ts";
import { extractMarkdown } from "./markdown.ts";
import type { PackageSurfaceResolver } from "./package-surface.ts";

export type LanguageAdvertisement = {
	id: string;
	extensions: readonly string[];
	capabilities: LanguageCapabilities;
};

export type AdapterRegistry = {
	register(adapter: LanguageAdapter): void;
	adapterForPath(path: string): LanguageAdapter | undefined;
	adapterForId(languageId: string): LanguageAdapter | undefined;
	registeredLanguages(): LanguageAdvertisement[];
	/** Deduped package-surface resolvers from adapters that declare the capability. */
	packageSurfaceResolvers(): readonly PackageSurfaceResolver[];
};

const MARKDOWN_EXTENSIONS = [".md", ".markdown", ".mdown"] as const;

const MARKDOWN_CAPABILITIES: LanguageCapabilities = {
	shape: true,
	search: false,
	fileDeps: false,
	callEdges: false,
	packageSurface: false,
};

function markdownAdapter(): LanguageAdapter {
	return {
		mode: "source",
		id: "markdown",
		extensions: MARKDOWN_EXTENSIONS,
		capabilities: MARKDOWN_CAPABILITIES,
		importNoiseIdentifiers: new Set(),
		extract: extractMarkdown,
	};
}

function createRegistry(seed: readonly LanguageAdapter[] = []): AdapterRegistry {
	const byId = new Map<string, LanguageAdapter>();
	const byExtension = new Map<string, LanguageAdapter>();

	const register = (adapter: LanguageAdapter): void => {
		if (byId.has(adapter.id)) {
			throw new Error(`Language adapter already registered: ${adapter.id}`);
		}
		for (const ext of adapter.extensions) {
			const key = ext.toLowerCase();
			if (!key.startsWith(".")) {
				throw new Error(`Language adapter ${adapter.id}: extension must start with '.': ${ext}`);
			}
			const existing = byExtension.get(key);
			if (existing !== undefined) {
				throw new Error(`Extension ${key} already registered by ${existing.id}; cannot register ${adapter.id}`);
			}
		}
		byId.set(adapter.id, adapter);
		for (const ext of adapter.extensions) {
			byExtension.set(ext.toLowerCase(), adapter);
		}
	};

	for (const adapter of seed) register(adapter);

	return {
		register,
		adapterForPath(path: string): LanguageAdapter | undefined {
			return byExtension.get(extname(path).toLowerCase());
		},
		adapterForId(languageId: string): LanguageAdapter | undefined {
			return byId.get(languageId);
		},
		registeredLanguages(): LanguageAdvertisement[] {
			return [...byId.values()].map((adapter) => ({
				id: adapter.id,
				extensions: adapter.extensions,
				capabilities: adapter.capabilities,
			}));
		},
		packageSurfaceResolvers(): readonly PackageSurfaceResolver[] {
			const out: PackageSurfaceResolver[] = [];
			const seen = new Set<PackageSurfaceResolver>();
			for (const adapter of byId.values()) {
				if (!adapter.capabilities.packageSurface) continue;
				const resolver = adapter.resolvePackageSurface;
				if (resolver === undefined || seen.has(resolver)) continue;
				seen.add(resolver);
				out.push(resolver);
			}
			return out;
		},
	};
}

/** Session registry: Markdown + grammar adapters. */
export function createDefaultRegistry(): AdapterRegistry {
	return createRegistry([
		markdownAdapter(),
		typescriptAdapter(),
		tsxAdapter(),
		goAdapter(),
		rustAdapter(),
		csharpAdapter(),
		javaAdapter(),
		kotlinAdapter(),
		swiftAdapter(),
		odinAdapter(),
	]);
}
