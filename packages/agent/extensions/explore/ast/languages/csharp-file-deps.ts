import { readFile } from "node:fs/promises";
import type { FileDepResolver } from "../adapter.ts";
import { collectFilesWithExtensions, externalId, internalPaths } from "./file-dep-util.ts";

type NamespaceIndex = Map<string, string[]>;

function normalizeUsing(specifier: string): string {
	return specifier
		.trim()
		.replace(/^global\s+/iu, "")
		.replace(/^static\s+/iu, "")
		.replace(/;$/u, "")
		.trim();
}

function namespaceFromSource(source: string): string | undefined {
	// file-scoped: namespace Foo.Bar;
	const fileScoped = /namespace\s+([A-Za-z_][\w.]*)\s*;/u.exec(source);
	if (fileScoped?.[1] !== undefined) return fileScoped[1];
	const block = /namespace\s+([A-Za-z_][\w.]*)\s*[{/]/u.exec(source);
	return block?.[1];
}

async function buildNamespaceIndex(host: Parameters<FileDepResolver>[2], signal: AbortSignal): Promise<NamespaceIndex> {
	const key = `csharp-ns:${host.scopeRoot}`;
	const cached = host.memo.get(key);
	if (cached !== undefined) return cached as NamespaceIndex;

	const index: NamespaceIndex = new Map();
	const files = await collectFilesWithExtensions(host, host.scopeRoot, [".cs"], signal);
	for (const file of files) {
		signal.throwIfAborted();
		let text: string;
		try {
			text = await readFile(file, "utf8");
		} catch {
			continue;
		}
		// Only scan a prefix — namespace is near the top.
		const head = text.slice(0, 4000);
		const ns = namespaceFromSource(head);
		if (ns === undefined) continue;
		const list = index.get(ns);
		if (list === undefined) index.set(ns, [file]);
		else list.push(file);
	}
	for (const [, list] of index) list.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
	host.memo.set(key, index);
	return index;
}

export const resolveCsharpFileDep: FileDepResolver = async (_fromPath, specifier, host, signal) => {
	signal.throwIfAborted();
	const ns = normalizeUsing(specifier);
	if (ns.length === 0) return { kind: "unresolved" };

	// Skip aliases: using X = Y;
	if (ns.includes("=")) return { kind: "unresolved" };

	const index = await buildNamespaceIndex(host, signal);
	const files = index.get(ns);
	if (files === undefined || files.length === 0) return externalId(ns);
	return internalPaths(files);
};
