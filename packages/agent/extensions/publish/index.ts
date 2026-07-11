import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { createGitRunner, type GitRunner, loadRepoStatus } from "../../shared/git.ts";
import { errorText } from "../../shared/text.ts";
import { PublishActivityPanel, type PublishProgress } from "./publish-ui.ts";

const PACKAGE_PATHS = ["packages/tui/package.json", "packages/agent/package.json"] as const;
const LOCKFILE_PATH = "package-lock.json";
const WORKFLOW_NAME = "publish.yml";
const WORKFLOW_WAIT_MS = 10 * 60_000;
const POLL_INTERVAL_MS = 5_000;

type Bump = "patch" | "minor" | "major";

interface PackageManifest {
	name: string;
	version: string;
	dependencies?: Record<string, string>;
}

interface WorkflowRun {
	databaseId: number;
	status: string;
	conclusion: string | null;
	url: string;
}

export default function publishExtension(pi: ExtensionAPI): void {
	pi.registerCommand("publish", {
		description: "Create a tagged release and monitor trusted npm publishing",
		handler: async (args, ctx) => {
			await ctx.waitForIdle();
			if (args.trim()) {
				ctx.ui.notify("Usage: /publish", "error");
				return;
			}
			if (!ctx.hasUI) {
				ctx.ui.notify("Publishing requires interactive confirmation.", "error");
				return;
			}
			try {
				await publish(pi, ctx);
			} catch (error) {
				ctx.ui.notify(`Publish failed: ${errorText(error)}`, "error");
			}
		},
	});
}

async function publish(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	const git = createGitRunner(pi, ctx);
	const repo = await loadRepoStatus(git);
	if (!repo) throw new Error("No git repository found.");
	if (repo.fileCount > 0)
		throw new Error("Working tree is not clean. Commit or stash every change before publishing.");
	await run(pi, ctx, "gh", ["auth", "status"], repo.root);

	const manifests = await loadManifests(repo.root);
	const currentVersion = sharedVersion(manifests);
	const tag = await latestReleaseTag(git, repo.root);
	const bump = await recommendBump(git, repo.root, tag);
	const version = tag ? incrementVersion(currentVersion, bump) : currentVersion;
	const selectedBump = await ctx.ui.select(`Release ${version}`, [
		`Use recommended ${bump} bump`,
		"Choose a different bump",
		"Cancel",
	]);
	if (!selectedBump || selectedBump === "Cancel") return;

	const finalBump =
		selectedBump === "Choose a different bump"
			? await ctx.ui.select("Release type", ["patch", "minor", "major"])
			: bump;
	if (!finalBump) return;
	const finalVersion = tag ? incrementVersion(currentVersion, finalBump as Bump) : currentVersion;
	const releaseTag = `v${finalVersion}`;
	if (await tagExists(git, repo.root, releaseTag)) throw new Error(`Tag ${releaseTag} already exists.`);

	const confirmed = await ctx.ui.confirm(
		`Publish ${releaseTag}?`,
		`This will push ${releaseTag}. GitHub Actions will publish @shanepadgett/tau-tui and @shanepadgett/tau-agent to npm.`,
	);
	if (!confirmed) return;

	if (ctx.mode !== "tui") {
		await completePublish(pi, ctx, git, repo.root, manifests, tag, finalVersion, releaseTag);
		return;
	}
	const failure = await ctx.ui.custom<Error | undefined>((tui, theme, _keybindings, done) => {
		const progress = new PublishActivityPanel(tui, theme, releaseTag);
		void completePublish(pi, ctx, git, repo.root, manifests, tag, finalVersion, releaseTag, progress)
			.then(() => done(undefined))
			.catch((error) => done(error instanceof Error ? error : new Error(errorText(error))));
		return progress;
	});
	if (failure) throw failure;
}

async function completePublish(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	git: GitRunner,
	root: string,
	manifests: readonly PackageManifest[],
	tag: string | undefined,
	version: string,
	releaseTag: string,
	progress: PublishProgress | undefined = undefined,
): Promise<void> {
	if (tag) {
		progress?.update("write package versions");
		await writeReleaseVersion(root, manifests, version);
	}
	progress?.update("npm pack --dry-run @shanepadgett/tau-tui");
	await run(pi, ctx, "npm", ["pack", "--dry-run", "--workspace", "@shanepadgett/tau-tui"], root);
	progress?.update("npm pack --dry-run @shanepadgett/tau-agent");
	await run(pi, ctx, "npm", ["pack", "--dry-run", "--workspace", "@shanepadgett/tau-agent"], root);

	if (tag) {
		progress?.update("git add release files");
		await git.run(["add", ...PACKAGE_PATHS, LOCKFILE_PATH], { cwd: root });
		progress?.update(`git commit chore(release): ${releaseTag}`);
		await git.run(["commit", "-m", `chore(release): ${releaseTag}`], { cwd: root });
	}
	progress?.update(`git tag ${releaseTag}`);
	await git.run(["tag", releaseTag], { cwd: root });
	progress?.update("git push origin HEAD");
	await git.run(["push", "origin", "HEAD"], { cwd: root, timeout: 120_000 });
	progress?.update(`git push origin ${releaseTag}`);
	await git.run(["push", "origin", releaseTag], { cwd: root, timeout: 120_000 });
	progress?.update("Waiting for GitHub Actions");
	await monitorWorkflow(pi, ctx, root, await git.run(["rev-parse", "HEAD"], { cwd: root }), releaseTag, progress);
}

async function loadManifests(root: string): Promise<PackageManifest[]> {
	return Promise.all(
		PACKAGE_PATHS.map(async (path) => JSON.parse(await readFile(join(root, path), "utf8")) as PackageManifest),
	);
}

function sharedVersion(manifests: readonly PackageManifest[]): string {
	const versions = new Set(manifests.map((manifest) => manifest.version));
	if (versions.size !== 1) throw new Error("Publishable packages must use the same version.");
	const version = manifests[0]?.version;
	if (!version || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error("Package version must be stable semver.");
	return version;
}

async function latestReleaseTag(git: GitRunner, root: string): Promise<string | undefined> {
	const tags = await git.run(["tag", "--list", "v*", "--sort=-version:refname"], { cwd: root });
	return tags.split("\n").find((tag) => /^v\d+\.\d+\.\d+$/.test(tag));
}

async function recommendBump(git: GitRunner, root: string, tag: string | undefined): Promise<Bump> {
	const range = tag ? `${tag}..HEAD` : "HEAD";
	const commits = await git.run(["log", "--format=%B%x00", range], { cwd: root });
	if (/BREAKING CHANGE:|^[^\n]*!:/m.test(commits)) return "major";
	if (/^feat(?:\([^\n]+\))?:/m.test(commits)) return "minor";
	return "patch";
}

function incrementVersion(version: string, bump: Bump): string {
	const match = version.match(/^(\d+)\.(\d+)\.(\d+)$/);
	if (!match) throw new Error(`Invalid version: ${version}`);
	const major = Number(match[1]);
	const minor = Number(match[2]);
	const patch = Number(match[3]);
	if (bump === "major") return `${major + 1}.0.0`;
	if (bump === "minor") return `${major}.${minor + 1}.0`;
	return `${major}.${minor}.${patch + 1}`;
}

async function tagExists(git: GitRunner, root: string, tag: string): Promise<boolean> {
	return Boolean(await git.run(["tag", "--list", tag], { cwd: root }));
}

async function writeReleaseVersion(
	root: string,
	manifests: readonly PackageManifest[],
	version: string,
): Promise<void> {
	for (const [index, path] of PACKAGE_PATHS.entries()) {
		const manifest = manifests[index];
		if (!manifest) throw new Error(`Missing package manifest: ${path}`);
		manifest.version = version;
		if (manifest.name === "@shanepadgett/tau-agent" && manifest.dependencies)
			manifest.dependencies["@shanepadgett/tau-tui"] = version;
		await writeFile(join(root, path), `${JSON.stringify(manifest, null, "\t")}\n`);
	}
	const lockfile = JSON.parse(await readFile(join(root, LOCKFILE_PATH), "utf8")) as {
		packages: Record<string, PackageManifest>;
	};
	for (const path of PACKAGE_PATHS) {
		const lockfilePath = path.slice(0, -"/package.json".length);
		const manifest = lockfile.packages[lockfilePath];
		if (!manifest) throw new Error(`Missing lockfile package: ${lockfilePath}`);
		manifest.version = version;
		if (manifest.name === "@shanepadgett/tau-agent" && manifest.dependencies)
			manifest.dependencies["@shanepadgett/tau-tui"] = version;
	}
	await writeFile(join(root, LOCKFILE_PATH), `${JSON.stringify(lockfile, null, "\t")}\n`);
}

async function run(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	command: string,
	args: string[],
	cwd: string,
): Promise<string> {
	const result = await pi.exec(command, args, { cwd, signal: ctx.signal, timeout: 120_000 });
	if (result.code === 0) return result.stdout.trim();
	throw new Error([result.stderr, result.stdout].filter(Boolean).join("\n").trim() || `${command} failed`);
}

async function monitorWorkflow(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	root: string,
	sha: string,
	tag: string,
	progress: PublishProgress | undefined = undefined,
): Promise<void> {
	const deadline = Date.now() + WORKFLOW_WAIT_MS;
	while (Date.now() < deadline) {
		const output = await run(
			pi,
			ctx,
			"gh",
			[
				"run",
				"list",
				"--workflow",
				WORKFLOW_NAME,
				"--commit",
				sha,
				"--limit",
				"1",
				"--json",
				"databaseId,status,conclusion,url",
			],
			root,
		);
		const workflowRun = (JSON.parse(output) as WorkflowRun[])[0];
		if (workflowRun) {
			progress?.update(`GitHub Actions: ${workflowRun.status}`, workflowRun.url);
			if (workflowRun.status === "completed") {
				if (workflowRun.conclusion === "success") {
					const version = tag.slice(1);
					ctx.ui.notify(
						[
							`Published ${tag}`,
							`GitHub Actions: ${workflowRun.url}`,
							`npm TUI: https://www.npmjs.com/package/@shanepadgett/tau-tui/v/${version}`,
							`npm Agent: https://www.npmjs.com/package/@shanepadgett/tau-agent/v/${version}`,
						].join("\n"),
						"info",
					);
					return;
				}
				throw new Error(`GitHub Actions ${workflowRun.conclusion ?? "failed"}: ${workflowRun.url}`);
			}
		}
		await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
	}
	throw new Error(`Timed out waiting for GitHub Actions for ${tag}. Check the Actions tab.`);
}
