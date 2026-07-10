import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { createGitRunner, type GitRunner } from "../../shared/git.ts";
import { errorText } from "../../shared/text.ts";
import { type BranchChoice, showBranchPanel } from "./panel.ts";

const GIT_FETCH_TIMEOUT_MS = 120_000;

const LIST_BRANCH_REFS_ARGS = [
	"for-each-ref",
	"--sort=-committerdate",
	"--format=%(refname)%00%(committerdate:unix)%00%(HEAD)%00%(symref)",
	"refs/heads",
	"refs/remotes",
];

export function normalizeBranchName(name: string): string {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "");
}

export default function branchExtension(pi: ExtensionAPI): void {
	pi.registerCommand("branch", {
		description: "Switch branches, or create one with /branch new",
		handler: async (args, ctx) => {
			await ctx.waitForIdle();

			const action = args.trim();
			if (action && action !== "new") {
				ctx.ui.notify("Usage: /branch or /branch new", "error");
				return;
			}

			if (!ctx.hasUI) {
				const operation = action === "new" ? "creation" : "switching";
				ctx.ui.notify(`Branch ${operation} requires interactive UI.`, "error");
				return;
			}
			if (action !== "new" && ctx.mode !== "tui") {
				ctx.ui.notify("Branch switching requires interactive TUI.", "error");
				return;
			}

			const git = createGitRunner(pi, ctx);
			try {
				if (action === "new") await createBranch(git, ctx);
				else await chooseBranch(git, ctx);
			} catch (error) {
				const operation = action === "new" ? "creation" : "switch";
				ctx.ui.notify(`Branch ${operation} failed: ${errorText(error)}`, "error");
			}
		},
	});
}

async function createBranch(git: GitRunner, ctx: ExtensionCommandContext): Promise<void> {
	const type = await ctx.ui.select("Branch type", ["feature", "fix", "chore"]);
	if (!type) return;

	const input = await ctx.ui.input("Branch name", "add branch command");
	if (input === undefined) return;

	const name = normalizeBranchName(input);
	if (!name) {
		ctx.ui.notify("Branch name must contain letters or numbers.", "error");
		return;
	}

	const root = await git.run(["rev-parse", "--show-toplevel"], { optional: true });
	if (!root) {
		ctx.ui.notify("No Git repository found.", "error");
		return;
	}

	const branch = `${type}/${name}`;
	await git.run(["switch", "-c", branch], { cwd: root });
	ctx.ui.notify(`Created and switched to ${branch}.`, "info");
}

async function chooseBranch(git: GitRunner, ctx: ExtensionCommandContext): Promise<void> {
	const root = await git.run(["rev-parse", "--show-toplevel"], { optional: true });
	if (!root) {
		ctx.ui.notify("No Git repository found.", "error");
		return;
	}

	const choice = await showBranchPanel(ctx, await loadBranchChoices(git, root), async () => {
		await git.run(["fetch", "--all"], { cwd: root, timeout: GIT_FETCH_TIMEOUT_MS });
		return loadBranchChoices(git, root);
	});
	if (!choice) return;

	if (choice.kind === "local") await git.run(["switch", choice.name], { cwd: root });
	else await git.run(["switch", "--track", "-c", choice.name, choice.upstream], { cwd: root });
	ctx.ui.notify(`Switched to ${choice.name}.`, "info");
}

async function loadBranchChoices(git: GitRunner, root: string): Promise<BranchChoice[]> {
	return parseBranchChoices(await git.run(LIST_BRANCH_REFS_ARGS, { cwd: root }));
}

function parseBranchChoices(output: string): BranchChoice[] {
	const refs = output
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			const [ref = "", seconds = "0", head = "", symref = ""] = line.split("\0");
			return { ref, updatedAt: Number(seconds) * 1000, current: head.trim() === "*", symbolic: Boolean(symref) };
		});
	const localPrefix = "refs/heads/";
	const remotePrefix = "refs/remotes/";
	const localNames = new Set(
		refs.filter(({ ref }) => ref.startsWith(localPrefix)).map(({ ref }) => ref.slice(localPrefix.length)),
	);
	const choices: BranchChoice[] = [];

	for (const ref of refs) {
		if (ref.ref.startsWith(localPrefix)) {
			const name = ref.ref.slice(localPrefix.length);
			if (name && !ref.current)
				choices.push({ id: `local:${name}`, kind: "local", label: name, name, updatedAt: ref.updatedAt });
			continue;
		}
		if (!ref.ref.startsWith(remotePrefix) || ref.symbolic) continue;

		const upstream = ref.ref.slice(remotePrefix.length);
		const separator = upstream.indexOf("/");
		if (separator < 1) continue;
		const name = upstream.slice(separator + 1);
		if (!name || name === "HEAD" || localNames.has(name)) continue;
		const label = localNames.has(upstream) ? `${upstream} (remote)` : upstream;
		choices.push({ id: `remote:${upstream}`, kind: "remote", label, name, upstream, updatedAt: ref.updatedAt });
	}

	return choices.sort((left, right) => right.updatedAt - left.updatedAt || left.label.localeCompare(right.label));
}
