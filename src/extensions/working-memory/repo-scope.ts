import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { WorkingMemorySettings } from "./settings.ts";

const AUTO_REREAD_MAX_BYTES = 50 * 1024;

export type RereadEligibility =
	| { ok: true; absolutePath: string; relativePath: string; byteLength: number }
	| { ok: false; relativePath: string; reason: string };

const execFileAsync = promisify(execFile);

export async function evaluateRereadEligibility(
	cwd: string,
	path: string,
	settings: WorkingMemorySettings,
): Promise<RereadEligibility> {
	const absolutePath = normalizeWorkingMemoryPath(cwd, path);
	if (!absolutePath) return { ok: false, relativePath: path, reason: "outside cwd" };
	const relativePath = toRelativePath(cwd, absolutePath);
	if (!relativePath) return { ok: false, relativePath: path, reason: "outside cwd" };
	if (isDependencyPath(relativePath)) return { ok: false, relativePath, reason: "dependency" };
	if (settings.excludedPaths.some((pattern) => matchesPattern(relativePath, pattern)))
		return { ok: false, relativePath, reason: "excluded" };
	const fileStat = await stat(absolutePath).catch((error: unknown) => {
		if (isNodeError(error) && error.code === "ENOENT") return "missing" as const;
		return undefined;
	});
	if (fileStat === "missing") return { ok: false, relativePath, reason: "missing" };
	if (!fileStat) return { ok: false, relativePath, reason: "unreadable" };
	if (!fileStat.isFile()) return { ok: false, relativePath, reason: "not file" };
	if (await isGitIgnored(cwd, relativePath)) return { ok: false, relativePath, reason: "ignored" };
	if (fileStat.size > AUTO_REREAD_MAX_BYTES) return { ok: false, relativePath, reason: "too large" };
	return { ok: true, absolutePath, relativePath, byteLength: fileStat.size };
}

export function normalizeWorkingMemoryPath(cwd: string, path: unknown): string | undefined {
	if (typeof path !== "string") return undefined;
	const cleaned = path.trim().replace(/^@/, "");
	if (!cleaned) return undefined;
	return isAbsolute(cleaned) ? resolve(cleaned) : resolve(cwd, cleaned);
}

function toRelativePath(cwd: string, absolutePath: string): string | undefined {
	const rel = relative(resolve(cwd), absolutePath);
	if (!rel || rel === ".") return undefined;
	if (rel === ".." || rel.startsWith(`..${sep}`)) return undefined;
	return rel.split(sep).join("/");
}

function isDependencyPath(path: string): boolean {
	return path.split("/").some((part) => part === ".git" || part === "node_modules");
}

function matchesPattern(path: string, pattern: string): boolean {
	const cleaned = pattern.trim().replace(/^@/, "").replace(/^\.\//, "").replace(/\/$/, "");
	if (!cleaned) return false;
	if (cleaned.includes("*")) {
		const escaped = cleaned
			.replace(/[.+?^${}()|[\]\\]/g, "\\$&")
			.replace(/\*\*/g, ".*")
			.replace(/\*/g, "[^/]*");
		return new RegExp(`^${escaped}$`).test(path);
	}
	return path === cleaned || path.startsWith(`${cleaned}/`);
}

async function isGitIgnored(cwd: string, path: string): Promise<boolean> {
	try {
		await execFileAsync("git", ["check-ignore", "-q", "--", path], { cwd });
		return true;
	} catch (error: unknown) {
		if (isNodeError(error) && typeof error.code === "number" && error.code === 1) return false;
		return false;
	}
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error;
}
