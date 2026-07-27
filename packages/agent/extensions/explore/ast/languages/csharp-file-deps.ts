import { readFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import type { FileDepHost, FileDepResolver } from "../adapter.ts";
import { collectFilesWithExtensions, externalId, internalPaths, isWithin } from "./file-dep-util.ts";

/**
 * C# file deps — ast-bro style.
 *
 * Index path suffixes + `namespace.Type` FQNs. Each `using` resolves to at most
 * one internal file (`pickClosest` on ties). Bare namespace usings that don't
 * match a type/path become external ids — never "every file in the namespace".
 */

type CsharpIndex = {
	/** slash-key → absolute paths */
	bySuffix: Map<string, string[]>;
};

/** BCL / engine — never treat polyfills as project file edges. */
function isFrameworkNamespace(ns: string): boolean {
	if (ns === "System" || ns.startsWith("System.")) return true;
	if (ns === "Microsoft" || ns.startsWith("Microsoft.")) return true;
	if (ns === "Windows" || ns.startsWith("Windows.")) return true;
	if (ns === "UnityEngine" || ns.startsWith("UnityEngine.")) return true;
	if (ns === "UnityEditor" || ns.startsWith("UnityEditor.")) return true;
	if (ns === "Godot" || ns.startsWith("Godot.")) return true;
	return false;
}

function normalizeUsing(specifier: string): string {
	let s = specifier.trim().replace(/;$/u, "").trim();
	s = s.replace(/^global\s+/iu, "").trim();
	s = s.replace(/^static\s+/iu, "").trim();
	// Alias: using A = X.Y.Z → resolve the target.
	const eq = s.indexOf("=");
	if (eq !== -1) s = s.slice(eq + 1).trim();
	return s;
}

const TYPE_KEYWORDS = ["class ", "struct ", "interface ", "record ", "enum ", "delegate "] as const;

/**
 * Scan source for namespace + type pairs (sequential — types bind to the
 * nearest preceding namespace declaration).
 */
function typesByNamespace(head: string): { ns: string; typeName: string }[] {
	const out: { ns: string; typeName: string }[] = [];
	let currentNs: string | undefined;
	for (const raw of head.split("\n")) {
		const line = raw.trim();
		if (line.length === 0 || line.startsWith("//")) continue;

		// file-scoped `namespace X;`, block `namespace X {`, or `namespace X` + brace next line
		const nsMatch =
			/^(?:internal\s+)?namespace\s+([A-Za-z_][\w.]*)\s*[;{]?\s*$/u.exec(line) ??
			/^(?:internal\s+)?namespace\s+([A-Za-z_][\w.]*)\s*[{/]/u.exec(line);
		if (nsMatch?.[1] !== undefined) {
			currentNs = nsMatch[1];
			continue;
		}
		if (currentNs === undefined) continue;

		for (const kw of TYPE_KEYWORDS) {
			const idx = line.indexOf(kw);
			if (idx === -1) continue;
			if (idx > 0 && /[A-Za-z0-9_]/u.test(line.charAt(idx - 1))) continue;
			const rest = line.slice(idx + kw.length).trimStart();
			const name = /^([A-Za-z_][\w]*)/u.exec(rest)?.[1];
			if (name !== undefined) out.push({ ns: currentNs, typeName: name });
			break;
		}
	}
	return out;
}

function pushSuffix(map: Map<string, string[]>, key: string, file: string): void {
	if (key.length === 0) return;
	const list = map.get(key);
	if (list === undefined) map.set(key, [file]);
	else if (!list.includes(file)) list.push(file);
}

/** Index every slash-suffix of a stem path: a/b/c → a/b/c, b/c, c */
function indexPathSuffixes(map: Map<string, string[]>, file: string, stemRelPosix: string): void {
	const parts = stemRelPosix.split("/").filter((part) => part.length > 0);
	for (let i = 0; i < parts.length; i += 1) {
		pushSuffix(map, parts.slice(i).join("/"), file);
	}
}

function toPosixRel(scopeRoot: string, file: string): string | undefined {
	const rel = relative(resolve(scopeRoot), resolve(file));
	if (rel.startsWith(`..${sep}`) || rel === ".." || rel.length === 0) return undefined;
	return rel.split(sep).join("/");
}

async function buildIndex(host: FileDepHost, signal: AbortSignal): Promise<CsharpIndex> {
	const key = `csharp-suffix:${host.scopeRoot}`;
	const cached = host.memo.get(key);
	if (cached !== undefined) return cached as CsharpIndex;

	const bySuffix = new Map<string, string[]>();
	const files = await collectFilesWithExtensions(host, host.scopeRoot, [".cs"], signal);

	for (const file of files) {
		signal.throwIfAborted();
		const rel = toPosixRel(host.scopeRoot, file);
		if (rel === undefined) continue;

		const dot = rel.lastIndexOf(".");
		const stem = dot >= 0 ? rel.slice(0, dot) : rel;
		indexPathSuffixes(bySuffix, file, stem);

		let text: string;
		try {
			text = await readFile(file, "utf8");
		} catch {
			continue;
		}
		const head = text.slice(0, 12000);
		// FQN only — bare type names are too ambiguous (Platform, View, …).
		for (const { ns, typeName } of typesByNamespace(head)) {
			const fqn = `${ns}.${typeName}`.replace(/\./gu, "/");
			pushSuffix(bySuffix, fqn, file);
		}
	}

	for (const [, list] of bySuffix) list.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
	const index: CsharpIndex = { bySuffix };
	host.memo.set(key, index);
	return index;
}

/** Prefer the candidate sharing the most path prefix with the importer. */
function pickClosest(candidates: readonly string[], fromPath: string): string | undefined {
	if (candidates.length === 0) return undefined;
	if (candidates.length === 1) return candidates[0];

	const fromSegs = resolve(fromPath).split(sep);
	let best: string | undefined;
	let bestCommon = -1;
	for (const candidate of candidates) {
		const segs = resolve(candidate).split(sep);
		let common = 0;
		const n = Math.min(fromSegs.length, segs.length);
		while (common < n && fromSegs[common] === segs[common]) common += 1;
		if (best === undefined || common > bestCommon || (common === bestCommon && candidate < best)) {
			best = candidate;
			bestCommon = common;
		}
	}
	return best;
}

function lookup(index: CsharpIndex, key: string): readonly string[] | undefined {
	const list = index.bySuffix.get(key);
	if (list === undefined || list.length === 0) return undefined;
	return list;
}

function resolveKey(index: CsharpIndex, fromPath: string, dotted: string): string | undefined {
	const key = dotted.replace(/\./gu, "/");
	const hit = pickClosest(lookup(index, key) ?? [], fromPath);
	if (hit !== undefined) return hit;

	// Nested type: Foo.Bar.Inner → try Foo.Bar file.
	const slash = key.lastIndexOf("/");
	if (slash <= 0) return undefined;
	const parent = key.slice(0, slash);
	return pickClosest(lookup(index, parent) ?? [], fromPath);
}

export const resolveCsharpFileDep: FileDepResolver = async (fromPath, specifier, host, signal) => {
	signal.throwIfAborted();
	const dotted = normalizeUsing(specifier);
	if (dotted.length === 0) return { kind: "unresolved" };

	if (isFrameworkNamespace(dotted)) return externalId(dotted);

	const index = await buildIndex(host, signal);
	const file = resolveKey(index, fromPath, dotted);
	if (file === undefined) return externalId(dotted);
	if (!isWithin(host.scopeRoot, file) && resolve(file) !== resolve(host.scopeRoot)) {
		return externalId(dotted);
	}
	if (!host.ownsPath(file)) return externalId(dotted);
	if (resolve(file) === resolve(fromPath)) return { kind: "unresolved" };
	return internalPaths([file]);
};
