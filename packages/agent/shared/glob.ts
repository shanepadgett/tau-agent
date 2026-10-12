import { sep } from "node:path";

export interface FileScope {
	matches(path: string): boolean;
	canDescend(path: string): boolean;
}

export function createFileScope(includeGlobs: readonly string[], excludeGlobs: readonly string[]): FileScope {
	const includes = includeGlobs.map(compilePattern);
	const excludes = excludeGlobs.map(compilePattern);
	// Only a trailing /** excludes an entire subtree. File globs must not prune directories.
	const excludedDirectories = excludeGlobs.filter((glob) => normalizeGlob(glob).endsWith("/**")).map(compilePattern);
	return {
		matches(path) {
			const segments = normalizeGlob(path).split("/");
			return (
				includes.some((pattern) => matchSegments(pattern, segments, 0, 0, false)) &&
				!excludes.some((pattern) => matchSegments(pattern, segments, 0, 0, false))
			);
		},
		canDescend(path) {
			const segments = normalizeGlob(path).split("/");
			return (
				includes.some((pattern) => matchSegments(pattern, segments, 0, 0, true)) &&
				!excludedDirectories.some((pattern) => matchSegments(pattern, segments, 0, 0, false))
			);
		},
	};
}

function compilePattern(pattern: string): (RegExp | "**")[] {
	return normalizeGlob(pattern)
		.split("/")
		.map((segment) => {
			if (segment === "**") return segment;
			const source = [...segment]
				.map((char) => {
					if (char === "*") return "[^/]*";
					if (char === "?") return "[^/]";
					return char.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
				})
				.join("");
			return new RegExp(`^${source}$`);
		});
}

function matchSegments(
	pattern: readonly (RegExp | "**")[],
	path: readonly string[],
	patternIndex: number,
	pathIndex: number,
	descendants: boolean,
): boolean {
	if (pathIndex === path.length && descendants) return patternIndex < pattern.length;
	const head = pattern[patternIndex];
	if (head === undefined) return pathIndex === path.length;
	if (head === "**")
		return (
			matchSegments(pattern, path, patternIndex + 1, pathIndex, descendants) ||
			(pathIndex < path.length && matchSegments(pattern, path, patternIndex, pathIndex + 1, descendants))
		);
	const pathHead = path[pathIndex];
	return (
		pathHead !== undefined &&
		head.test(pathHead) &&
		matchSegments(pattern, path, patternIndex + 1, pathIndex + 1, descendants)
	);
}

function normalizeGlob(value: string): string {
	return posixPath(value.trim())
		.replace(/^\.\//, "")
		.replace(/^\/+|\/+$/g, "");
}

export function posixPath(value: string): string {
	return sep === "/" ? value : value.split(sep).join("/");
}
