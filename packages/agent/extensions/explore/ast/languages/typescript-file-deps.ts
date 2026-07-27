import { dirname, extname, join, resolve } from "node:path";
import type { FileDepResolver } from "../adapter.ts";
import { externalId, firstExistingFile, internalPaths, packageNameFromBareSpecifier } from "./file-dep-util.ts";

const TS_SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".mtsx"] as const;

function pushTsStems(out: string[], stem: string): void {
	for (const sourceExt of TS_SOURCE_EXTENSIONS) out.push(`${stem}${sourceExt}`);
}

function sourceCandidatesFromSeed(seed: string): string[] {
	const out = [seed];
	const ext = extname(seed);
	if (ext === ".js" || ext === ".mjs" || ext === ".cjs" || ext === ".jsx") {
		pushTsStems(out, seed.slice(0, -ext.length));
		if (ext === ".jsx") out.push(`${seed.slice(0, -ext.length)}.tsx`);
	} else if (seed.endsWith(".d.ts")) {
		pushTsStems(out, seed.slice(0, -".d.ts".length));
	} else if (ext === "") {
		for (const sourceExt of TS_SOURCE_EXTENSIONS) {
			out.push(`${seed}${sourceExt}`, join(seed, `index${sourceExt}`));
		}
	} else if (TS_SOURCE_EXTENSIONS.includes(ext as (typeof TS_SOURCE_EXTENSIONS)[number])) {
		// already exact
	} else {
		pushTsStems(out, seed);
		for (const sourceExt of TS_SOURCE_EXTENSIONS) out.push(join(seed, `index${sourceExt}`));
	}
	return out;
}

async function resolveRelative(
	host: Parameters<FileDepResolver>[2],
	baseDir: string,
	target: string,
): Promise<string | undefined> {
	const absolute = resolve(baseDir, target);
	const candidates = sourceCandidatesFromSeed(absolute);
	// Prefer source over ambient .d.ts / emitted js.
	const preferred = candidates.filter((path) => {
		if (path.endsWith(".d.ts")) return false;
		const ext = extname(path);
		return ext !== ".js" && ext !== ".mjs" && ext !== ".cjs" && ext !== ".jsx";
	});
	const hit = await firstExistingFile(host, preferred);
	if (hit !== undefined) return hit;
	return firstExistingFile(host, candidates);
}

export const resolveTypescriptFileDep: FileDepResolver = async (fromPath, specifier, host, signal) => {
	signal.throwIfAborted();
	const trimmed = specifier.trim();
	if (trimmed.length === 0) return { kind: "unresolved" };
	if (trimmed.startsWith("node:") || trimmed.startsWith("data:")) {
		return externalId(packageNameFromBareSpecifier(trimmed));
	}
	if (trimmed.startsWith("./") || trimmed.startsWith("../")) {
		const file = await resolveRelative(host, dirname(fromPath), trimmed);
		if (file === undefined) return { kind: "unresolved" };
		return internalPaths([file]);
	}
	return externalId(packageNameFromBareSpecifier(trimmed));
};
