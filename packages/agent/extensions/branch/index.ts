import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
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

function normalizeBranchName(name: string): string {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "");
}

export default function branchExtension(pi: ExtensionAPI): void {
	pi.registerCommand("branch", {
		description: "Switch branches, or create one with /branch new",
		getArgumentCompletions(prefix: string): AutocompleteItem[] | null {
			const value = prefix.trimStart();
			if (/\s/.test(value)) return null;

			const item = { value: "new", label: "new", description: "Create a new branch" };
			return item.value.startsWith(value) ? [item] : null;
		},
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

	const confirmed = await ctx.ui.confirm(
		`Switch to ${choice.name}?`,
		"After switch, untracked files and folders will be removed. Ignored files like .env stay.",
	);
	if (!confirmed) return;

	if (choice.kind === "local") await git.run(["switch", choice.name], { cwd: root });
	else await git.run(["switch", "--track", "-c", choice.name, choice.upstream], { cwd: root });
	await git.run(["clean", "-fd"], { cwd: root });
	ctx.ui.notify(`Switched to ${choice.name}.`, "info");
}

async function loadBranchChoices(git: GitRunner, root: string): Promise<BranchChoice[]> {
	return parseBranchChoices(await git.run(LIST_BRANCH_REFS_ARGS, { cwd: root }));
}

interface ParsedRef {
	ref: string;
	updatedAt: number;
	current: boolean;
	symbolic: boolean;
}

function parseRefLines(output: string): ParsedRef[] {
	return output
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			const [ref = "", seconds = "0", head = "", symref = ""] = line.split("\0");
			return { ref, updatedAt: Number(seconds) * 1000, current: head.trim() === "*", symbolic: Boolean(symref) };
		});
}

function localChoice(ref: ParsedRef): BranchChoice | undefined {
	const name = ref.ref.slice("refs/heads/".length);
	if (!name || ref.current) return undefined;
	return { id: `local:${name}`, kind: "local", label: name, name, updatedAt: ref.updatedAt };
}

function remoteChoice(ref: ParsedRef, localNames: ReadonlySet<string>): BranchChoice | undefined {
	if (ref.symbolic) return undefined;
	const upstream = ref.ref.slice("refs/remotes/".length);
	const separator = upstream.indexOf("/");
	if (separator < 1) return undefined;
	const name = upstream.slice(separator + 1);
	if (!name || name === "HEAD" || localNames.has(name)) return undefined;
	const label = localNames.has(upstream) ? `${upstream} (remote)` : upstream;
	return { id: `remote:${upstream}`, kind: "remote", label, name, upstream, updatedAt: ref.updatedAt };
}

function parseBranchChoices(output: string): BranchChoice[] {
	const refs = parseRefLines(output);
	const localNames = new Set(
		refs.filter(({ ref }) => ref.startsWith("refs/heads/")).map(({ ref }) => ref.slice("refs/heads/".length)),
	);
	const choices: BranchChoice[] = [];
	for (const ref of refs) {
		if (ref.ref.startsWith("refs/heads/")) {
			const choice = localChoice(ref);
			if (choice) choices.push(choice);
			continue;
		}
		if (!ref.ref.startsWith("refs/remotes/")) continue;
		const choice = remoteChoice(ref, localNames);
		if (choice) choices.push(choice);
	}
	return choices.sort((left, right) => right.updatedAt - left.updatedAt || left.label.localeCompare(right.label));
}
