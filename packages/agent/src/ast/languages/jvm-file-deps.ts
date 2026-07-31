import { resolve } from "node:path";
import type { FileDepResolver } from "../adapter.ts";
import { buildDottedIndex, resolveDottedFile, resolveDottedPackage, type HeadScan } from "./dotted-index.ts";
import { externalId, internalPaths, isWithin, packageDirectory } from "./file-dep-util.ts";

/**
 * Java / Kotlin file deps. Real multi-module builds put module B's sources
 * anywhere, so resolution goes through a package-path index rather than a fixed
 * list of source-root suffixes: a type import resolves to the declaring file, a
 * wildcard or top-level member import to the package directory.
 */

type JvmFileDepOptions = {
	/** File extensions to match, e.g. .java / .kt */
	extensions: readonly string[];
	/** Leading packages always treated as external. */
	externalPrefixes: readonly string[];
	/** Top-level declaration keywords, in this language's syntax. */
	declarationPattern: RegExp;
	memoPrefix: string;
};

const PACKAGE_LINE = /^[ \t]*package\s+([\w.]+)\s*;?[ \t]*$/mu;

function scanJvmHead(head: string, declarationPattern: RegExp): HeadScan {
	const pkg = PACKAGE_LINE.exec(head)?.[1] ?? "";
	if (pkg.length === 0) return { packages: [], names: [] };
	const names: HeadScan["names"] = [];
	// Fresh lastIndex per scan: the pattern is shared across files.
	const pattern = new RegExp(declarationPattern.source, declarationPattern.flags);
	for (const match of head.matchAll(pattern)) {
		const name = match[2];
		if (name !== undefined) names.push({ pkg, name });
	}
	return { packages: [pkg], names };
}

function startsLower(text: string): boolean {
	const first = text.charAt(0);
	return first.length > 0 && first === first.toLowerCase() && first !== first.toUpperCase();
}

/**
 * Split an import into the dotted path plus how it should resolve.
 * Package segments are lowercase and type segments capitalized, so the first
 * capitalized segment ends a type import; an import with none names a package
 * member (Kotlin top-level fun/val) and resolves to the package.
 */
function classifyImport(specifier: string): { path: string; packageLike: boolean } {
	let s = specifier.trim().replace(/;$/u, "");
	s = s.replace(/^static\s+/u, "");
	if (s.endsWith(".*")) {
		// Keep the full package path — do not peel segments (all-lowercase packages).
		return { path: s.slice(0, -2).trim(), packageLike: true };
	}
	const parts = s.split(".").filter((part) => part.length > 0);
	const typeAt = parts.findIndex((part) => !startsLower(part));
	// pkg.Type.member / pkg.Type.Companion.member all resolve through pkg.Type.
	if (typeAt >= 0) return { path: parts.slice(0, typeAt + 1).join("."), packageLike: false };
	if (parts.length <= 1) return { path: parts.join("."), packageLike: false };
	return { path: parts.slice(0, -1).join("."), packageLike: true };
}

function isExternalPackage(path: string, prefixes: readonly string[]): boolean {
	for (const prefix of prefixes) {
		if (path === prefix || path.startsWith(`${prefix}.`)) return true;
	}
	return false;
}

function createJvmFileDepResolver(options: JvmFileDepOptions): FileDepResolver {
	return async (fromPath, specifier, host, signal) => {
		signal.throwIfAborted();
		const { path, packageLike } = classifyImport(specifier);
		if (path.length === 0) return { kind: "unresolved" };
		if (isExternalPackage(path, options.externalPrefixes)) return externalId(path);

		const index = await buildDottedIndex(
			host,
			options.memoPrefix,
			options.extensions,
			(head) => scanJvmHead(head, options.declarationPattern),
			signal,
		);

		if (packageLike) {
			const pkg = resolveDottedPackage(index, fromPath, path);
			if (pkg === undefined || !isWithin(host.scopeRoot, pkg.dir)) return externalId(path);
			return packageDirectory(path, pkg.dir, pkg.fileCount);
		}

		const file = resolveDottedFile(index, fromPath, path);
		if (file !== undefined && isWithin(host.scopeRoot, file) && host.ownsPath(file)) {
			if (resolve(file) === resolve(fromPath)) return { kind: "unresolved" };
			return internalPaths([file]);
		}
		// No declaring file, but the package may still be in the repo: generated
		// sources (Android `R`, Apollo fragments) and declarations below the head
		// window land here, and the package they live in is the real dependency.
		const owningPackage = path.split(".").slice(0, -1).join(".");
		const pkg = owningPackage.length === 0 ? undefined : resolveDottedPackage(index, fromPath, owningPackage);
		if (pkg === undefined || !isWithin(host.scopeRoot, pkg.dir)) return externalId(path);
		return packageDirectory(owningPackage, pkg.dir, pkg.fileCount);
	};
}

const MODIFIERS =
	"public|protected|private|static|final|abstract|sealed|non-sealed|strictfp|default|internal|open|data|value|annotation|enum|expect|actual|external|inline|suspend|const|lateinit|companion|operator|infix|tailrec";

/** `@Anno`s and modifiers, then the keyword and the declared name. */
const JAVA_DECLARATION = new RegExp(
	`^[ \\t]*(?:@[\\w.]+(?:\\([^)]*\\))?[ \\t]*)*(?:(?:${MODIFIERS})[ \\t]+)*(class|interface|enum|record|@interface)\\s+([A-Za-z_]\\w*)`,
	"gmu",
);

/** Kotlin also indexes top-level fun/val/typealias; the optional dotted part is an extension receiver. */
const KOTLIN_DECLARATION = new RegExp(
	`^[ \\t]*(?:@[\\w.]+(?:\\([^)]*\\))?[ \\t]*)*(?:(?:${MODIFIERS})[ \\t]+)*(class|interface|object|fun|val|var|typealias)\\s+(?:<[^>]*>\\s+)?(?:[A-Za-z_][\\w.]*\\.)?([A-Za-z_]\\w*)`,
	"gmu",
);

export const resolveJavaFileDep = createJvmFileDepResolver({
	extensions: [".java"],
	externalPrefixes: ["java", "javax", "jakarta", "jdk", "sun"],
	declarationPattern: JAVA_DECLARATION,
	memoPrefix: "java-dotted",
});

export const resolveKotlinFileDep = createJvmFileDepResolver({
	// .kts is often Gradle — not a package type file.
	extensions: [".kt", ".java"],
	externalPrefixes: ["java", "javax", "jakarta", "kotlin", "kotlinx"],
	declarationPattern: KOTLIN_DECLARATION,
	memoPrefix: "kotlin-dotted",
});
