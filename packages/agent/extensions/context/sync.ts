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
import { pathExists } from "./definitions.ts";
import contextSettings from "./settings.ts";
import { formatContextValidationFailure, listEligibleDirtyPaths, validateContextCatalog } from "./validation.ts";

const CONTEXT_SYNC_AGENT = "context-sync";

export interface ContextSyncDetails {
	outcome: "applied" | "no-change" | "failed" | "cancelled";
	summary: string;
	reason: string;
	changedContextFiles: string[];
	agentResponse?: string;
	validationFailure?: string;
}

type SyncStatus = (status: string) => void | Promise<void>;
type GitRunner = ReturnType<typeof createGitRunner>;

let syncQueue = Promise.resolve();

export async function runContextSync(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	options: { nudge?: string; signal?: AbortSignal; onStatus?: SyncStatus } = {},
): Promise<ContextSyncDetails> {
	return withSyncLock(() => runContextSyncLocked(pi, ctx, options));
}

function noChangeResult(reason: string, agentResponse?: string): ContextSyncDetails {
	return {
		outcome: "no-change",
		summary: "Existing context mappings already fit the changed scope.",
		reason,
		changedContextFiles: [],
		agentResponse,
	};
}

async function inspectSyncNeed(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	nudge: string | undefined,
	onStatus?: SyncStatus,
): Promise<
	| { kind: "done"; result: ContextSyncDetails }
	| { kind: "run"; git: GitRunner; root: string; ignoreGlobs: readonly string[] }
> {
	await onStatus?.("Inspecting repository context");
	const git = createGitRunner(pi, ctx);
	const status = await loadRepoStatus(git);
	if (!status) throw new Error("No Git repository found");
	const settings = await loadTauExtensionSettings(ctx, contextSettings);
	const ignoreGlobs = settings.validation.ignoreGlobs;
	const validation = await validateContextCatalog(git, status.root, ignoreGlobs);
	const dirtyEligible = await listEligibleDirtyPaths(git, status.root, ignoreGlobs);
	const force = Boolean(nudge?.trim());
	if (!force && validation.stale.length === 0 && validation.uncovered.length === 0 && dirtyEligible.length === 0) {
		return {
			kind: "done",
			result: noChangeResult("No eligible dirty files, stale catalog paths, or sync nudge."),
		};
	}
	return { kind: "run", git, root: status.root, ignoreGlobs };
}

async function resolveContextSyncDefinition(ctx: ExtensionContext) {
	const discovery = await discoverAgents(ctx.cwd, ctx.isProjectTrusted());
	const definition = discovery.agents.get(CONTEXT_SYNC_AGENT);
	if (definition) return definition;
	const reason =
		discovery.invalid
			.get(CONTEXT_SYNC_AGENT)
			?.map((item) => item.reason)
			.join("; ") ?? "unknown agent";
	throw new Error(`Context sync agent unavailable: ${reason}`);
}

async function runContextSyncAgent(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	root: string,
	nudge: string | undefined,
	signal: AbortSignal,
	onStatus: SyncStatus | undefined,
	beforeCatalog: Map<string, string>,
): Promise<ContextSyncDetails | { agentResponse: string }> {
	const definition = await resolveContextSyncDefinition(ctx);
	const task = buildContextSyncTask(root, nudge);
	await onStatus?.("Running context-sync subagent");
	const thread = await createSubagentThread({
		id: `context-sync-${Date.now()}`,
		displayName: definition.names[0] ?? definition.name,
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
	try {
		const result = await runSubagentTurn({
			thread,
			task,
			initial: true,
			signal,
			onUpdate: async (details) => {
				const activity = details.currentActivity ?? details.response;
				if (activity) await onStatus?.(activity.slice(0, 160));
			},
		});
		if (signal.aborted || result.details.status === "aborted") return cancelledResult(result.content);
		if (result.details.status !== "completed") {
			return {
				outcome: "failed",
				summary: "Context sync subagent failed.",
				reason: result.details.error ?? result.content,
				changedContextFiles: changedCatalogPaths(beforeCatalog, await catalogFileSnapshot(root)),
				agentResponse: result.content,
			};
		}
		return { agentResponse: result.content };
	} finally {
		await disposeSubagentThread(thread);
	}
}

async function finalizeContextSync(
	git: GitRunner,
	root: string,
	ignoreGlobs: readonly string[],
	beforeCatalog: Map<string, string>,
	agentResponse: string,
	onStatus?: SyncStatus,
): Promise<ContextSyncDetails> {
	const changedContextFiles = changedCatalogPaths(beforeCatalog, await catalogFileSnapshot(root));
	await onStatus?.("Verifying context catalog");
	const validationFailure = formatContextValidationFailure(await validateContextCatalog(git, root, ignoreGlobs));
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
		return noChangeResult(agentResponse.trim() || "Context-sync subagent made no catalog edits.", agentResponse);
	}
	return {
		outcome: "applied",
		summary: `Updated context catalog (${changedContextFiles.length} file${changedContextFiles.length === 1 ? "" : "s"}).`,
		reason: agentResponse.trim() || "Context-sync subagent updated the catalog.",
		changedContextFiles,
		agentResponse,
	};
}

async function runContextSyncLocked(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	options: { nudge?: string; signal?: AbortSignal; onStatus?: SyncStatus },
): Promise<ContextSyncDetails> {
	if (!ctx.isProjectTrusted()) throw new Error("Context sync requires a trusted project");
	const signal = options.signal ?? ctx.signal ?? new AbortController().signal;
	if (signal.aborted) return cancelledResult();

	const need = await inspectSyncNeed(pi, ctx, options.nudge, options.onStatus);
	if (need.kind === "done") return need.result;
	if (signal.aborted) return cancelledResult();

	const beforeCatalog = await catalogFileSnapshot(need.root);
	const agentResult = await runContextSyncAgent(
		pi,
		ctx,
		need.root,
		options.nudge,
		signal,
		options.onStatus,
		beforeCatalog,
	);
	if ("outcome" in agentResult) return agentResult;
	if (signal.aborted) return cancelledResult(agentResult.agentResponse);
	return finalizeContextSync(
		need.git,
		need.root,
		need.ignoreGlobs,
		beforeCatalog,
		agentResult.agentResponse,
		options.onStatus,
	);
}

function cancelledResult(agentResponse?: string): ContextSyncDetails {
	return {
		outcome: "cancelled",
		summary: "Context sync cancelled",
		reason: agentResponse?.trim() || "Cancelled by user.",
		changedContextFiles: [],
		agentResponse,
	};
}

function buildContextSyncTask(root: string, nudge?: string): string {
	const trimmed = nudge?.trim();
	return [
		`Keep the repository context catalog at ${root} honest.`,
		"Job: update `.pi/contexts` so work packs match the codebase.",
		"Use normal repo tools. Prefer patch for catalog edits under `.pi/contexts`.",
		"Walk domain → concept → job entry before placing paths. Harness verifies catalog coverage after you finish.",
		trimmed ? `Human nudge (soft steer, does not skip the ladder or coverage):\n${trimmed}` : undefined,
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
	const stack = [base];
	while (stack.length > 0) {
		const directory = stack.pop();
		if (!directory) continue;
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			const fullPath = join(directory, entry.name);
			if (entry.isDirectory()) {
				stack.push(fullPath);
				continue;
			}
			if (!entry.isFile() || extname(entry.name) !== ".toml") continue;
			const relativePath = relative(root, fullPath).split(sep).join("/");
			const content = await readFile(fullPath, "utf8");
			snapshot.set(relativePath, createHash("sha256").update(content).digest("hex"));
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
