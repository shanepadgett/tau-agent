import { dirname, join, relative, resolve, sep } from "node:path";
import type { FileDepResolver } from "../adapter.ts";
import { externalId, firstExistingFile, internalPaths, isWithin } from "./file-dep-util.ts";

type JvmFileDepOptions = {
	/** File extensions to match, e.g. .java / .kt */
	extensions: readonly string[];
	/** Leading packages always treated as external. */
	externalPrefixes: readonly string[];
	/** Extra source-root suffixes under scope (relative). */
	sourceRootSuffixes: readonly string[];
};

function stripImportNoise(specifier: string): { path: string; wildcard: boolean } {
	let s = specifier.trim().replace(/;$/u, "");
	s = s.replace(/^static\s+/u, "");
	const wildcard = s.endsWith(".*");
	if (wildcard) s = s.slice(0, -2);
	// Static/member imports: pkg.Type.member or pkg.Type.Companion.member → peel trailing
	// non-type segments (lowercase start, or Companion/INSTANCE).
	const parts = s.split(".").filter((part) => part.length > 0);
	while (parts.length > 1) {
		const last = parts[parts.length - 1];
		if (last === undefined) break;
		if (last === "Companion" || last === "INSTANCE" || last === "Default") {
			parts.pop();
			continue;
		}
		// Java/Kotlin type names are typically UpperCamel; members start lower.
		const start = last.charAt(0);
		if (start !== "" && start === start.toLowerCase() && start !== start.toUpperCase()) {
			parts.pop();
			continue;
		}
		break;
	}
	return { path: parts.join("."), wildcard };
}

function isExternalPackage(path: string, prefixes: readonly string[]): boolean {
	for (const prefix of prefixes) {
		if (path === prefix || path.startsWith(`${prefix}.`)) return true;
	}
	return false;
}

function segmentsOf(dotted: string): string[] {
	return dotted.split(".").filter((part) => part.length > 0);
}

/** Infer source root by peeling package segments off dirname(fromPath). */
function inferredSourceRoot(fromPath: string, packageSegments: readonly string[]): string | undefined {
	if (packageSegments.length === 0) return dirname(fromPath);
	const dir = resolve(dirname(fromPath));
	const parts = dir.split(sep);
	if (parts.length < packageSegments.length) return undefined;
	const tail = parts.slice(parts.length - packageSegments.length);
	if (tail.join("/") !== packageSegments.join("/") && tail.join(sep) !== packageSegments.join(sep)) {
		// compare case-sensitive path segments
		for (let i = 0; i < packageSegments.length; i += 1) {
			if (tail[i] !== packageSegments[i]) return undefined;
		}
	}
	return parts.slice(0, parts.length - packageSegments.length).join(sep) || sep;
}

async function filesInPackageDir(
	host: Parameters<FileDepResolver>[2],
	dir: string,
	extensions: readonly string[],
): Promise<string[]> {
	const names = await host.readDir(dir);
	const out: string[] = [];
	for (const name of names) {
		const lower = name.toLowerCase();
		if (!extensions.some((ext) => lower.endsWith(ext))) continue;
		const full = join(dir, name);
		if ((await host.isFile(full)) && host.ownsPath(full) && isWithin(host.scopeRoot, full)) out.push(full);
	}
	return out;
}

async function resolveAgainstRoot(
	host: Parameters<FileDepResolver>[2],
	sourceRoot: string,
	segments: readonly string[],
	wildcard: boolean,
	extensions: readonly string[],
): Promise<string[]> {
	if (!isWithin(host.scopeRoot, sourceRoot) && resolve(sourceRoot) !== resolve(host.scopeRoot)) {
		// allow source roots under scope only
		if (!isWithin(host.scopeRoot, sourceRoot)) return [];
	}
	if (wildcard || segments.length === 0) {
		const dir = segments.length === 0 ? sourceRoot : join(sourceRoot, ...segments);
		return filesInPackageDir(host, dir, extensions);
	}
	// type name = last segment
	const typeName = segments[segments.length - 1];
	const pkg = segments.slice(0, -1);
	if (typeName === undefined) return [];
	const dir = pkg.length === 0 ? sourceRoot : join(sourceRoot, ...pkg);
	const candidates = extensions.map((ext) => join(dir, `${typeName}${ext}`));
	const file = await firstExistingFile(host, candidates);
	if (file !== undefined && isWithin(host.scopeRoot, file)) return [file];
	// package-only import style without .* — try as package dir
	const asPkg = join(sourceRoot, ...segments);
	return filesInPackageDir(host, asPkg, extensions);
}

function sourceRootsFor(
	host: Parameters<FileDepResolver>[2],
	fromPath: string,
	importSegments: readonly string[],
	suffixes: readonly string[],
): string[] {
	const roots = new Set<string>();
	// Peel one segment as possible type from fromPath package guess via path
	const fromDir = dirname(fromPath);
	const relToScope = relative(host.scopeRoot, fromDir);
	if (!relToScope.startsWith("..") && !isAbsoluteRel(relToScope)) {
		// try every ancestor as potential source root
		const parts = relToScope.length === 0 ? [] : relToScope.split(sep);
		for (let i = 0; i <= parts.length; i += 1) {
			roots.add(i === 0 ? host.scopeRoot : join(host.scopeRoot, ...parts.slice(0, i)));
		}
	}
	const inferred = inferredSourceRoot(fromPath, guessPackageSegments(fromPath, host.scopeRoot));
	if (inferred !== undefined) roots.add(inferred);

	for (const suffix of suffixes) {
		roots.add(join(host.scopeRoot, ...suffix.split("/").filter((p) => p.length > 0)));
	}

	// Prefer roots that could contain the import path
	void importSegments;
	return [...roots];
}

function isAbsoluteRel(rel: string): boolean {
	return rel.length > 0 && (rel.startsWith(sep) || /^[A-Za-z]:[\\/]/u.test(rel));
}

function guessPackageSegments(fromPath: string, scopeRoot: string): string[] {
	const rel = relative(scopeRoot, dirname(fromPath));
	if (rel.startsWith("..") || rel.length === 0) return [];
	const parts = rel.split(sep);
	// Drop common source root prefixes
	const dropPrefixes = [
		["src", "main", "java"],
		["src", "main", "kotlin"],
		["src", "commonMain", "kotlin"],
		["src", "commonMain", "java"],
		["src", "jvmMain", "kotlin"],
		["src", "test", "java"],
		["src", "test", "kotlin"],
		["src"],
	];
	for (const prefix of dropPrefixes) {
		if (parts.length >= prefix.length && prefix.every((p, i) => parts[i] === p)) {
			return parts.slice(prefix.length);
		}
	}
	// guava layout: guava/src/com/...
	const comAt = parts.indexOf("com");
	const orgAt = parts.indexOf("org");
	const netAt = parts.indexOf("net");
	const idx = [comAt, orgAt, netAt].filter((v) => v >= 0).sort((a, b) => a - b)[0];
	if (idx !== undefined) return parts.slice(idx);
	return parts;
}

function createJvmFileDepResolver(options: JvmFileDepOptions): FileDepResolver {
	return async (fromPath, specifier, host, signal) => {
		signal.throwIfAborted();
		const raw = specifier
			.trim()
			.replace(/;$/u, "")
			.replace(/^static\s+/u, "");
		const { path, wildcard } = stripImportNoise(specifier);
		if (path.length === 0) return { kind: "unresolved" };
		if (isExternalPackage(path, options.externalPrefixes)) return externalId(path);

		const segments = segmentsOf(path);
		// Top-level function/property import (okio.buffer): peeled to package-only.
		// Avoid fanning out every file in the package.
		const rawParts = raw
			.replace(/\.\*$/u, "")
			.split(".")
			.filter((part) => part.length > 0);
		const lastRaw = rawParts[rawParts.length - 1];
		const memberLike =
			lastRaw !== undefined &&
			lastRaw !== "Companion" &&
			lastRaw.charAt(0) === lastRaw.charAt(0).toLowerCase() &&
			lastRaw.charAt(0) !== lastRaw.charAt(0).toUpperCase();
		const packageOnly =
			segments.length > 0 &&
			segments.every((seg) => {
				const c = seg.charAt(0);
				return c === c.toLowerCase() && c !== c.toUpperCase();
			});
		if (!wildcard && memberLike && packageOnly) {
			return externalId(raw.replace(/\.\*$/u, ""));
		}

		const roots = sourceRootsFor(host, fromPath, segments, options.sourceRootSuffixes);
		for (const root of roots) {
			signal.throwIfAborted();
			const files = await resolveAgainstRoot(host, root, segments, wildcard, options.extensions);
			if (files.length > 0) return internalPaths(files);
		}
		return externalId(path);
	};
}

export const resolveJavaFileDep = createJvmFileDepResolver({
	extensions: [".java"],
	externalPrefixes: ["java", "javax", "jakarta", "jdk", "sun"],
	sourceRootSuffixes: ["src/main/java", "src"],
});

export const resolveKotlinFileDep = createJvmFileDepResolver({
	// .kts is often Gradle — not a package type file.
	extensions: [".kt", ".java"],
	externalPrefixes: ["java", "javax", "jakarta", "kotlin", "kotlinx"],
	sourceRootSuffixes: [
		"src/main/kotlin",
		"src/main/java",
		"src/commonMain/kotlin",
		"src/commonMain/java",
		"src/jvmMain/kotlin",
		"src",
	],
});
