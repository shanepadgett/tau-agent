import { resolve } from "node:path";
import type { FileDepResolver } from "../adapter.ts";
import { buildDottedIndex, resolveDottedFile, resolveDottedPackage, type HeadScan } from "./dotted-index.ts";
import { externalId, internalPaths, isWithin, packageDirectory } from "./file-dep-util.ts";

/**
 * C# file deps. A `using` names a namespace, so it resolves to that namespace's
 * directory as a package edge; alias usings (`using A = X.Y.Type;`) name one
 * type and resolve to its file.
 */

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
 * Namespace + type pairs, scanned sequentially — types bind to the nearest
 * preceding namespace declaration.
 */
function scanCsharpHead(head: string): HeadScan {
	const names: HeadScan["names"] = [];
	const packages: string[] = [];
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
			packages.push(currentNs);
			continue;
		}
		if (currentNs === undefined) continue;

		for (const kw of TYPE_KEYWORDS) {
			const idx = line.indexOf(kw);
			if (idx === -1) continue;
			if (idx > 0 && /[A-Za-z0-9_]/u.test(line.charAt(idx - 1))) continue;
			const rest = line.slice(idx + kw.length).trimStart();
			const name = /^([A-Za-z_][\w]*)/u.exec(rest)?.[1];
			if (name !== undefined) names.push({ pkg: currentNs, name });
			break;
		}
	}
	return { packages, names };
}

export const resolveCsharpFileDep: FileDepResolver = async (fromPath, specifier, host, signal) => {
	signal.throwIfAborted();
	const dotted = normalizeUsing(specifier);
	if (dotted.length === 0) return { kind: "unresolved" };
	if (isFrameworkNamespace(dotted)) return externalId(dotted);

	const index = await buildDottedIndex(host, "csharp-dotted", [".cs"], scanCsharpHead, signal);

	// Namespace first: a plain `using` imports the whole namespace, not one file.
	const pkg = resolveDottedPackage(index, fromPath, dotted);
	if (pkg !== undefined && isWithin(host.scopeRoot, pkg.dir)) {
		return packageDirectory(dotted, pkg.dir, pkg.fileCount);
	}

	const file = resolveDottedFile(index, fromPath, dotted);
	if (file === undefined) return externalId(dotted);
	if (!isWithin(host.scopeRoot, file) || !host.ownsPath(file)) return externalId(dotted);
	if (resolve(file) === resolve(fromPath)) return { kind: "unresolved" };
	return internalPaths([file]);
};
