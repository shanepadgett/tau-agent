import { sep } from "node:path";

export function matchGlob(pattern: string, path: string): boolean {
	return matchSegments(normalizeGlob(pattern).split("/"), normalizeGlob(path).split("/"));
}

function matchSegments(pattern: readonly string[], path: readonly string[]): boolean {
	const [head, ...tail] = pattern;
	if (head === undefined) return path.length === 0;
	if (head === "**") return matchSegments(tail, path) || (path.length > 0 && matchSegments(pattern, path.slice(1)));
	const [pathHead, ...pathTail] = path;
	return pathHead !== undefined && matchSegment(head, pathHead) && matchSegments(tail, pathTail);
}

function matchSegment(pattern: string, value: string): boolean {
	const source = [...pattern]
		.map((char) => {
			if (char === "*") return "[^/]*";
			if (char === "?") return "[^/]";
			return char.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
		})
		.join("");
	return new RegExp(`^${source}$`).test(value);
}

function normalizeGlob(value: string): string {
	return posixPath(value.trim())
		.replace(/^\.\//, "")
		.replace(/^\/+|\/+$/g, "");
}

export function posixPath(value: string): string {
	return sep === "/" ? value : value.split(sep).join("/");
}
