// fallow-ignore-file unused-file,unused-export -- wired by 06-outline-show
import { extname } from "node:path";
import type { LanguageAdapter, LanguageCapabilities } from "./adapter.ts";
import { extractMarkdown } from "./markdown.ts";

export type LanguageAdvertisement = {
	id: string;
	extensions: readonly string[];
	capabilities: LanguageCapabilities;
};

export type AdapterRegistry = {
	register(adapter: LanguageAdapter): void;
	adapterForPath(path: string): LanguageAdapter | undefined;
	adapterForExtension(extension: string): LanguageAdapter | undefined;
	registeredLanguages(): LanguageAdvertisement[];
	capabilitiesFor(languageId: string): LanguageCapabilities | undefined;
};

const MARKDOWN_EXTENSIONS = [".md", ".markdown", ".mdown"] as const;

const MARKDOWN_CAPABILITIES: LanguageCapabilities = {
	shape: true,
	search: false,
	fileDeps: false,
	callEdges: false,
	packageSurface: false,
};

export function markdownAdapter(): LanguageAdapter {
	return {
		mode: "source",
		id: "markdown",
		extensions: MARKDOWN_EXTENSIONS,
		capabilities: MARKDOWN_CAPABILITIES,
		extract: extractMarkdown,
	};
}

export function createRegistry(seed: readonly LanguageAdapter[] = []): AdapterRegistry {
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
		adapterForExtension(extension: string): LanguageAdapter | undefined {
			const key = extension.startsWith(".") ? extension.toLowerCase() : `.${extension.toLowerCase()}`;
			return byExtension.get(key);
		},
		registeredLanguages(): LanguageAdvertisement[] {
			return [...byId.values()].map((adapter) => ({
				id: adapter.id,
				extensions: adapter.extensions,
				capabilities: adapter.capabilities,
			}));
		},
		capabilitiesFor(languageId: string): LanguageCapabilities | undefined {
			return byId.get(languageId)?.capabilities;
		},
	};
}

/** Session registry with Markdown always present. Grammar adapters register later. */
export function createDefaultRegistry(): AdapterRegistry {
	return createRegistry([markdownAdapter()]);
}
