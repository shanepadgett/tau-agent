import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

const DEFAULT_GIT_TIMEOUT_MS = 10_000;

export interface GitRunner {
	cwd: string;
	run(args: string[], optional?: boolean, timeout?: number): Promise<string>;
}

export function createGitRunner(pi: ExtensionAPI, ctx: ExtensionCommandContext): GitRunner {
	return {
		cwd: ctx.cwd,
		async run(args, optional = false, timeout = DEFAULT_GIT_TIMEOUT_MS) {
			const result = await pi.exec("git", args, { cwd: this.cwd, signal: ctx.signal, timeout });
			if (result.code === 0) return result.stdout.trim();
			if (optional) return "";

			const details = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
			throw new Error(details || `git ${args.join(" ")} failed with exit code ${result.code}`);
		},
	};
}
