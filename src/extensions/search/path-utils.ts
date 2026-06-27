import { spawn } from "node:child_process";
import { isAbsolute, relative, resolve, sep } from "node:path";

const SEARCH_NOISE_DIRS = new Set([
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

function stripAt(path: string): string {
	return path.trim().replace(/^@/, "");
}

export function resolveSearchPath(cwd: string, rawPath: unknown): string | undefined {
	if (typeof rawPath !== "string") return undefined;
	const cleaned = stripAt(rawPath);
	if (!cleaned) return undefined;
	return isAbsolute(cleaned) ? resolve(cleaned) : resolve(cwd, cleaned);
}

export function displayPath(cwd: string, absolutePath: string): string {
	const rel = relative(resolve(cwd), resolve(absolutePath));
	if (!rel || rel === ".") return ".";
	if (rel === ".." || rel.startsWith(`..${sep}`)) return resolve(absolutePath);
	return rel.split(sep).join("/");
}

export function hasNoisePart(path: string): boolean {
	return path.split(/[\\/]/).some((part) => SEARCH_NOISE_DIRS.has(part));
}

export function isHiddenPath(path: string): boolean {
	return path.split(/[\\/]/).some((part) => part.startsWith(".") && part !== "." && part !== "..");
}

export function matchesGlob(path: string, pattern: string): boolean {
	const cleaned = stripAt(pattern).replace(/^\.\//, "");
	if (!cleaned) return true;
	const escaped = cleaned
		.replace(/[.+?^${}()|[\]\\]/g, "\\$&")
		.replace(/\*\*/g, ".*")
		.replace(/\*/g, "[^/]*");
	return new RegExp(`^${escaped}$`).test(path);
}

export async function gitIgnored(cwd: string, paths: string[]): Promise<Set<string>> {
	const candidates = [...new Set(paths.filter((path) => path && !path.startsWith("..")))];
	if (candidates.length === 0) return new Set();
	return new Promise((resolveIgnored) => {
		let stdout = "";
		const child = spawn("git", ["check-ignore", "--stdin"], { cwd, shell: false });
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
		});
		child.on("error", () => resolveIgnored(new Set()));
		child.on("close", (code) => resolveIgnored(code === 0 ? new Set(stdout.split("\n").filter(Boolean)) : new Set()));
		child.stdin.end(`${candidates.join("\n")}\n`);
	});
}

export function matchesExcluded(path: string, patterns: readonly string[]): boolean {
	return patterns.some((pattern) => {
		const cleaned = stripAt(pattern).replace(/^\.\//, "").replace(/\/$/, "");
		if (!cleaned) return false;
		if (cleaned.includes("*")) return matchesGlob(path, cleaned);
		return path === cleaned || path.startsWith(`${cleaned}/`);
	});
}

export function fairShares(count: number, limit: number): number[] {
	const safeCount = Math.max(1, count);
	const base = Math.floor(limit / safeCount);
	let extra = limit % safeCount;
	return Array.from({ length: count }, () => base + (extra-- > 0 ? 1 : 0));
}
