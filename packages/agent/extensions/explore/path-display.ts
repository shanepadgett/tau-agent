import { isAbsolute, relative, resolve } from "node:path";

export function stripLeadingAt(value: string): string {
	return value.startsWith("@") ? value.slice(1) : value;
}

export function toSlashPath(value: string): string {
	return value.replace(/\\/g, "/");
}

export function resolveExplorePath(cwd: string, input: string): string {
	const path = stripLeadingAt(input);
	if (path.length === 0) return resolve(cwd);
	return isAbsolute(path) ? resolve(path) : resolve(cwd, path);
}

export function pathResolutionError(error: unknown, input: string): Error {
	if (error instanceof Error && "code" in error && error.code === "ENOENT") {
		return new Error(`Path not found: ${stripLeadingAt(input)}`);
	}
	return error instanceof Error ? error : new Error(String(error));
}

export function isWithinPath(parent: string, child: string): boolean {
	const rel = relative(resolve(parent), resolve(child));
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function formatPathForDisplay(absolutePath: string, cwd: string): string {
	const resolvedCwd = resolve(cwd);
	const resolvedPath = resolve(absolutePath);
	const rel = relative(resolvedCwd, resolvedPath);
	if (rel === "") return ".";
	if (!rel.startsWith("..") && !isAbsolute(rel)) return toSlashPath(rel);
	return toSlashPath(resolvedPath);
}

export function relativeSlash(from: string, to: string): string {
	const rel = relative(resolve(from), resolve(to));
	return rel === "" ? "." : toSlashPath(rel);
}
