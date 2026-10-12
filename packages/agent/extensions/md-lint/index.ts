import { stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { main } from "markdownlint-cli2";
import { createFileScope, type FileScope } from "../../shared/glob.ts";
import { isModifyingTool, walkFiles } from "../../shared/project-files.ts";
import { registerPromptSource } from "../../shared/prompt-contributions.ts";
import { loadTauExtensionSettings } from "../../shared/settings/load.ts";
import { resolveProjectRoot } from "../../shared/settings/paths.ts";
import mdLintSettings from "./settings.ts";

const CONFIG_PATH = join(dirname(fileURLToPath(import.meta.url)), "markdownlint-cli2.jsonc");

interface FileStats {
	mtimeMs: number;
	size: number;
}

type Snapshot = Map<string, FileStats>;

interface Settings {
	enabled: boolean;
	scope: FileScope;
}

type Notify = (message: string, type?: "info" | "warning" | "error") => void;

function normalizeSettings(value: typeof mdLintSettings.defaults): Settings {
	return {
		enabled: value.enabled ?? true,
		scope: createFileScope(["**/*.md"], (value.ignoreGlobs ?? []).map((glob) => glob.trim()).filter(Boolean)),
	};
}

export default function mdLintExtension(pi: ExtensionAPI): void {
	let settings: Settings = normalizeSettings(mdLintSettings.defaults);
	let snapshot: Snapshot | undefined;
	let queue: Promise<void> = Promise.resolve();
	let sessionActive = false;
	const writeCalls = new Set<string>();

	pi.on("session_start", async (_event, ctx) => {
		settings = normalizeSettings(await loadTauExtensionSettings(ctx, mdLintSettings));
		sessionActive = true;
		snapshot = undefined;
		writeCalls.clear();
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
		writeCalls.clear();
		snapshot = await walkMarkdownStats(projectRoot, settings.scope, ctx.signal);
	});

	pi.on("tool_call", (event) => {
		if (!settings.enabled || !sessionActive) return;
		const tool = pi.getAllTools().find((entry) => entry.name === event.toolName);
		if (!isModifyingTool(event.toolName, tool?.annotations?.readOnlyHint)) return;
		if ([...writeCalls].some((id) => event.toolCallId.startsWith(`${id}/`))) return;
		writeCalls.add(event.toolCallId);
	});

	// Format changed Markdown in the background; the handler returns without waiting.
	pi.on("tool_result", async (event, ctx) => {
		if (!writeCalls.delete(event.toolCallId)) return;
		if (!settings.enabled || !sessionActive) return;
		const cwd = ctx.cwd;
		const notify = ctx.ui.notify;
		queue = queue.then(() => fixChangedMarkdown(cwd, notify, ctx.signal)).catch(() => {});
	});

	pi.on("session_shutdown", () => {
		sessionActive = false;
		writeCalls.clear();
	});

	async function fixChangedMarkdown(cwd: string, notify: Notify, signal: AbortSignal | undefined): Promise<void> {
		if (!settings.enabled || !sessionActive || signal?.aborted) return;
		const projectRoot = await resolveProjectRoot(cwd);
		const current = await walkMarkdownStats(projectRoot, settings.scope, signal);
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

async function walkMarkdownStats(root: string, scope: FileScope, signal: AbortSignal | undefined): Promise<Snapshot> {
	const stats: Snapshot = new Map();
	for (const path of await walkFiles(root, [scope], signal)) {
		signal?.throwIfAborted();
		try {
			const info = await stat(join(root, path));
			stats.set(path, { mtimeMs: info.mtimeMs, size: info.size });
		} catch {
			// unreadable file — treat as absent
		}
	}
	return stats;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
