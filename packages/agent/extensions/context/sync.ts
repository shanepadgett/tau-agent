import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { extname, join, relative, sep } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createGitRunner, loadRepoStatus } from "../../shared/git.ts";
import { loadTauExtensionSettings } from "../../shared/settings/load.ts";
import { discoverAgents } from "../subagent/agents.ts";
import {
	createSubagentThread,
	disposeSubagentThread,
	extensionPathsForTools,
	runSubagentTurn,
} from "../subagent/run.ts";
import { collectSyncEvidence, CONTEXT_SYNC_EVIDENCE_TOOL } from "./evidence.ts";
import { pathExists } from "./definitions.ts";
import contextSettings from "./settings.ts";
import { formatContextValidationFailure, validateContextCatalog } from "./validation.ts";
import { restoreOutsideContextMutations, snapshotOutsideContext } from "./write-scope.ts";

const CONTEXT_SYNC_AGENT = "context-sync";

export interface ContextSyncDetails {
	outcome: "applied" | "no-change" | "failed";
	summary: string;
	reason: string;
	changedContextFiles: string[];
	agentResponse?: string;
	validationFailure?: string;
}

let syncQueue = Promise.resolve();

export async function runContextSync(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	options: { nudge?: string; signal?: AbortSignal; onStatus?: (status: string) => void | Promise<void> } = {},
): Promise<ContextSyncDetails> {
	return withSyncLock(() => runContextSyncLocked(pi, ctx, options));
}

async function runContextSyncLocked(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	options: { nudge?: string; signal?: AbortSignal; onStatus?: (status: string) => void | Promise<void> },
): Promise<ContextSyncDetails> {
	if (!ctx.isProjectTrusted()) throw new Error("Context sync requires a trusted project");
	await options.onStatus?.("Inspecting repository context");
	const git = createGitRunner(pi, ctx);
	const status = await loadRepoStatus(git);
	if (!status) throw new Error("No Git repository found");
	const settings = await loadTauExtensionSettings(ctx, contextSettings);
	const evidence = await collectSyncEvidence(git, status.root, settings.validation.ignoreGlobs);
	if (evidence.files.length === 0 && evidence.missingPaths.size === 0)
		return {
			outcome: "no-change",
			summary: "Existing context mappings already fit the changed scope.",
			reason: "Changed files are outside context catalog scope.",
			changedContextFiles: [],
		};

	const beforeCatalog = await catalogFileSnapshot(status.root);
	const outsideBefore = await snapshotOutsideContext(git, status.root);
	const discovery = await discoverAgents(ctx.cwd, ctx.isProjectTrusted());
	const definition = discovery.agents.get(CONTEXT_SYNC_AGENT);
	if (!definition) {
		const reason =
			discovery.invalid
				.get(CONTEXT_SYNC_AGENT)
				?.map((item) => item.reason)
				.join("; ") ?? "unknown agent";
		throw new Error(`Context sync agent unavailable: ${reason}`);
	}

	const task = buildContextSyncTask(status.root, options.nudge);
	const signal = options.signal ?? ctx.signal ?? new AbortController().signal;

	await options.onStatus?.("Running context-sync subagent");
	const thread = await createSubagentThread({
		id: `context-sync-${Date.now()}`,
		definition,
		extensionPaths: extensionPathsForTools(pi, definition.tools),
		initialTask: task,
		ctx,
		thinkingLevel: pi.getThinkingLevel(),
		signal,
		onWarning: (warning) => {
			ctx.ui.notify(`Context sync agent: ${warning}`, "warning");
		},
	});
	let agentResponse = "";
	try {
		const result = await runSubagentTurn({
			thread,
			task,
			initial: true,
			signal,
			onUpdate: async (details) => {
				const activity = details.currentActivity ?? details.response;
				if (activity) await options.onStatus?.(activity.slice(0, 160));
			},
		});
		agentResponse = result.content;
		if (result.details.status !== "completed") {
			const writeScopeViolations = await restoreOutsideContextMutations(git, status.root, outsideBefore);
			return {
				outcome: "failed",
				summary: "Context sync subagent failed.",
				reason: [
					result.details.error ?? result.content,
					writeScopeViolations.length
						? `Restored out-of-scope writes:\n${writeScopeViolations.map((path) => `- ${path}`).join("\n")}`
						: undefined,
				]
					.filter((line): line is string => Boolean(line))
					.join("\n\n"),
				changedContextFiles: changedCatalogPaths(beforeCatalog, await catalogFileSnapshot(status.root)),
				agentResponse,
			};
		}
	} finally {
		await disposeSubagentThread(thread);
	}

	await options.onStatus?.("Verifying write scope");
	const writeScopeViolations = await restoreOutsideContextMutations(git, status.root, outsideBefore);
	const afterCatalog = await catalogFileSnapshot(status.root);
	const changedContextFiles = changedCatalogPaths(beforeCatalog, afterCatalog);
	if (writeScopeViolations.length > 0) {
		return {
			outcome: "failed",
			summary: "Context sync wrote outside .pi/contexts; out-of-scope paths were restored.",
			reason: `Out-of-scope writes restored:\n${writeScopeViolations.map((path) => `- ${path}`).join("\n")}`,
			changedContextFiles,
			agentResponse,
		};
	}

	await options.onStatus?.("Verifying context catalog");
	const validationFailure = formatContextValidationFailure(
		await validateContextCatalog(git, status.root, settings.validation.ignoreGlobs),
	);
	if (validationFailure) {
		return {
			outcome: "failed",
			summary: "Context sync finished but catalog invariants still fail.",
			reason: validationFailure,
			changedContextFiles,
			agentResponse,
			validationFailure,
		};
	}
	if (changedContextFiles.length === 0) {
		return {
			outcome: "no-change",
			summary: "Existing context mappings already fit the changed scope.",
			reason: agentResponse.trim() || "Context-sync subagent made no catalog edits.",
			changedContextFiles: [],
			agentResponse,
		};
	}
	return {
		outcome: "applied",
		summary: `Updated context catalog (${changedContextFiles.length} file${changedContextFiles.length === 1 ? "" : "s"}).`,
		reason: agentResponse.trim() || "Context-sync subagent updated the catalog.",
		changedContextFiles,
		agentResponse,
	};
}

export function buildContextSyncTask(root: string, nudge?: string): string {
	const trimmed = nudge?.trim();
	return [
		`Synchronize the repository context catalog at ${root}.`,
		"Use context_sync_evidence for git/catalog facts. Edit only .pi/contexts with patch.",
		"Walk the typology ladder out loud before path placement. Recheck invariants before finishing.",
		trimmed ? `Human nudge (soft steer, does not skip evidence or ladder):\n${trimmed}` : undefined,
	]
		.filter((line): line is string => Boolean(line))
		.join("\n\n");
}

async function withSyncLock<T>(task: () => Promise<T>): Promise<T> {
	const previous = syncQueue;
	let release = () => {};
	syncQueue = new Promise<void>((resolve) => {
		release = resolve;
	});
	await previous;
	try {
		return await task();
	} finally {
		release();
	}
}

async function catalogFileSnapshot(root: string): Promise<Map<string, string>> {
	const snapshot = new Map<string, string>();
	const base = join(root, ".pi", "contexts");
	if (!(await pathExists(base))) return snapshot;
	for (const tab of (await readdir(base, { withFileTypes: true }))
		.filter((item) => item.isDirectory())
		.sort((a, b) => a.name.localeCompare(b.name))) {
		for (const file of (await readdir(join(base, tab.name), { withFileTypes: true }))
			.filter((item) => item.isFile() && extname(item.name) === ".toml")
			.sort((a, b) => a.name.localeCompare(b.name))) {
			const absolute = join(base, tab.name, file.name);
			const path = relative(root, absolute).split(sep).join("/");
			const hash = createHash("sha256")
				.update(await readFile(absolute))
				.digest("hex");
			snapshot.set(path, hash);
		}
	}
	return snapshot;
}

function changedCatalogPaths(before: Map<string, string>, after: Map<string, string>): string[] {
	const paths = new Set([...before.keys(), ...after.keys()]);
	return [...paths]
		.filter((path) => before.get(path) !== after.get(path))
		.sort((left, right) => left.localeCompare(right));
}

// Ensure evidence tool name stays aligned with agent definition tooling.
export const CONTEXT_SYNC_REQUIRED_TOOLS = [
	"read",
	"ls",
	"find",
	"grep",
	"bash",
	"patch",
	CONTEXT_SYNC_EVIDENCE_TOOL,
] as const;
