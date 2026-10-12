import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { posixPath, type FileScope } from "./glob.ts";

const WRITE_TOOLS = new Set([
	"patch",
	"write",
	"edit",
	"bash",
	"powershell",
	"eval",
	"codemode",
	"image_gen",
	"screenshot_window",
]);
const READ_TOOLS = new Set(["read", "grep", "find", "ls", "tool_search"]);
const WALK_SKIP_DIRS = new Set([
	".git",
	"node_modules",
	"dist",
	"build",
	"coverage",
	".cache",
	".next",
	".turbo",
	".parcel-cache",
	"out",
]);

export function isModifyingTool(name: string, readOnlyHint: boolean | undefined): boolean {
	return WRITE_TOOLS.has(name) || (!READ_TOOLS.has(name) && readOnlyHint !== true);
}

export async function walkFiles(
	root: string,
	scopes: readonly FileScope[],
	signal: AbortSignal | undefined,
): Promise<string[]> {
	const files: string[] = [];
	if (scopes.length === 0) return files;
	await walkDir(root, "", scopes, files, signal);
	return files;
}

async function walkDir(
	root: string,
	relativeDir: string,
	scopes: readonly FileScope[],
	files: string[],
	signal: AbortSignal | undefined,
): Promise<void> {
	signal?.throwIfAborted();
	for (const entry of await readdir(resolve(root, relativeDir), { withFileTypes: true })) {
		signal?.throwIfAborted();
		const path = posixPath(relativeDir ? `${relativeDir}/${entry.name}` : entry.name);
		if (entry.isDirectory()) {
			if (WALK_SKIP_DIRS.has(entry.name)) continue;
			const descendants = scopes.filter((scope) => scope.canDescend(path));
			if (descendants.length > 0) await walkDir(root, path, descendants, files, signal);
		} else if (entry.isFile() && scopes.some((scope) => scope.matches(path))) {
			files.push(path);
		}
	}
}
