import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

const DEFAULT_GIT_TIMEOUT_MS = 10_000;

export interface GitRunner {
	cwd: string;
	run(args: string[], options?: { cwd?: string; optional?: boolean; timeout?: number }): Promise<string>;
}

export function createGitRunner(pi: ExtensionAPI, ctx: ExtensionCommandContext): GitRunner {
	return {
		cwd: ctx.cwd,
		async run(args, options = {}) {
			const result = await pi.exec("git", args, {
				cwd: options.cwd ?? this.cwd,
				signal: ctx.signal,
				timeout: options.timeout ?? DEFAULT_GIT_TIMEOUT_MS,
			});
			if (result.code === 0) return result.stdout.trim();
			if (options.optional) return "";

			const details = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
			throw new Error(details || `git ${args.join(" ")} failed with exit code ${result.code}`);
		},
	};
}

export interface RepoStatus {
	root: string;
	fileCount: number;
}

// Resolves the repo root and counts dirty entries (staged, unstaged, and
// untracked). Returns null outside a git repo; returns fileCount 0 when the
// tree is clean. Callers surface each case.
export async function loadRepoStatus(git: GitRunner): Promise<RepoStatus | null> {
	const root = await git.run(["rev-parse", "--show-toplevel"], { optional: true });
	if (!root) return null;
	const status = await git.run(["status", "--porcelain=v1", "--untracked-files=all"], { cwd: root });
	return { root, fileCount: status ? status.split("\n").filter(Boolean).length : 0 };
}
