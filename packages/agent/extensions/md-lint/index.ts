import { readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { main } from "markdownlint-cli2";
import { matchGlob, posixPath } from "../../shared/glob.ts";
import { registerPromptSource } from "../../shared/prompt-contributions.ts";
import { loadTauExtensionSettings } from "../../shared/settings/load.ts";
import { resolveProjectRoot } from "../../shared/settings/paths.ts";
import mdLintSettings from "./settings.ts";

const CONFIG_PATH = join(dirname(fileURLToPath(import.meta.url)), "markdownlint-cli2.jsonc");
const WALK_SKIP_DIRS = new Set([
	".git",
	"node_modules",
	"dist",
	"build",
	"coverage",
	"out",
	".cache",
	".next",
	".turbo",
	".parcel-cache",
]);

interface FileStats {
	mtimeMs: number;
	size: number;
}

type Snapshot = Map<string, FileStats>;

interface Settings {
	enabled: boolean;
	ignoreGlobs: string[];
}

type Notify = (message: string, type?: "info" | "warning" | "error") => void;

function normalizeSettings(value: typeof mdLintSettings.defaults): Settings {
	return {
		enabled: value.enabled ?? true,
		ignoreGlobs: (value.ignoreGlobs ?? []).map((glob) => glob.trim()).filter(Boolean),
	};
}

export default function mdLintExtension(pi: ExtensionAPI): void {
	let settings: Settings = normalizeSettings(mdLintSettings.defaults);
	let snapshot: Snapshot | undefined;
	let queue: Promise<void> = Promise.resolve();
	let sessionActive = false;

	pi.on("session_start", async (_event, ctx) => {
		settings = normalizeSettings(await loadTauExtensionSettings(ctx, mdLintSettings));
		sessionActive = true;
		snapshot = undefined;
	});

	registerPromptSource(pi, {
		key: "md-lint/instructions",
		section: "automatic-checks",
		refresh: "append",
		async read(ctx) {
			settings = normalizeSettings(await loadTauExtensionSettings(ctx, mdLintSettings));
			if (!settings.enabled) return "";
			return [
				"Markdown files are formatted automatically after changes.",
				"Do not run markdownlint, a markdown lint task, or a markdown formatter manually for files you change. Complete the work and finish normally; formatting is applied automatically and silently without entering agent context.",
			].join("\n");
		},
	});

	// Snapshot Markdown files before the run's first tool call so tool changes are detectable.
	pi.on("agent_start", async (_event, ctx) => {
		if (!settings.enabled || !sessionActive) return;
		await queue;
		if (!sessionActive) return;
		const projectRoot = await resolveProjectRoot(ctx.cwd);
		snapshot = await walkMarkdownStats(projectRoot, settings.ignoreGlobs);
	});

	// Format changed Markdown in the background; the handler returns without waiting.
	pi.on("tool_result", async (_event, ctx) => {
		if (!settings.enabled || !sessionActive) return;
		const cwd = ctx.cwd;
		const notify = ctx.ui.notify;
		queue = queue.then(() => fixChangedMarkdown(cwd, notify)).catch(() => {});
	});

	pi.on("session_shutdown", () => {
		sessionActive = false;
	});

	async function fixChangedMarkdown(cwd: string, notify: Notify): Promise<void> {
		if (!settings.enabled || !sessionActive) return;
		const projectRoot = await resolveProjectRoot(cwd);
		const current = await walkMarkdownStats(projectRoot, settings.ignoreGlobs);
		if (snapshot === undefined) {
			snapshot = current;
			return;
		}
		const changed: string[] = [];
		for (const [path, fileStats] of current) {
			const prior = snapshot.get(path);
			if (prior === undefined || prior.mtimeMs !== fileStats.mtimeMs || prior.size !== fileStats.size) {
				changed.push(path);
			}
		}
		if (changed.length > 0) {
			try {
				await main({
					directory: projectRoot,
					argv: ["--config", CONFIG_PATH, "--fix", ...changed.map((path) => `:${path}`)],
					noGlobs: true,
				});
				for (const path of changed) {
					try {
						const after = await stat(join(projectRoot, path));
						snapshot.set(path, { mtimeMs: after.mtimeMs, size: after.size });
					} catch {
						snapshot.delete(path);
					}
				}
			} catch (error: unknown) {
				notify(`md-lint: markdownlint failed: ${errorMessage(error)}`, "error");
			}
		}
		for (const path of snapshot.keys()) {
			if (!current.has(path)) snapshot.delete(path);
		}
		for (const [path, fileStats] of current) {
			if (!snapshot.has(path)) snapshot.set(path, fileStats);
		}
	}
}

async function walkMarkdownStats(root: string, ignoreGlobs: readonly string[]): Promise<Snapshot> {
	const stats: Snapshot = new Map();
	await walkDir(root, "", stats, ignoreGlobs);
	return stats;
}

async function walkDir(
	root: string,
	relativeDir: string,
	stats: Snapshot,
	ignoreGlobs: readonly string[],
): Promise<void> {
	const dir = relativeDir ? join(root, relativeDir) : root;
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const relativePath = posixPath(relativeDir ? `${relativeDir}/${entry.name}` : entry.name);
		if (entry.isDirectory()) {
			if (!WALK_SKIP_DIRS.has(entry.name)) await walkDir(root, relativePath, stats, ignoreGlobs);
			continue;
		}
		if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
		if (ignoreGlobs.some((glob) => matchGlob(glob, relativePath))) continue;
		try {
			const info = await stat(join(root, relativePath));
			stats.set(relativePath, { mtimeMs: info.mtimeMs, size: info.size });
		} catch {
			// unreadable file — treat as absent
		}
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
