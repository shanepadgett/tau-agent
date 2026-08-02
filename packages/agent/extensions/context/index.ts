import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { prepareFileInjection } from "@shanepadgett/tau-agent";
import { createGitRunner, loadRepoStatus } from "../../shared/git.ts";
import { loadTauExtensionSettings } from "../../shared/settings/load.ts";
import { findProjectRoot, loadContextEntries, type ContextEntry, type ContextShowTarget } from "./definitions.ts";
import { ContextPanel, ContextSyncStatusPanel } from "./panel.ts";
import contextSettings from "./settings.ts";
import { type ContextSyncDetails, runContextSync } from "./sync.ts";
import { formatContextValidationFailure, validateContextCatalog } from "./validation.ts";

const CONTEXT_BRIEF_TYPE = "tau.context.brief";

const SHOW_RANK = {
	signature: 0,
	signatureWithDocs: 1,
	declaration: 2,
	declarationWithImports: 3,
} as const;

function collectInjectionPlan(selected: readonly ContextEntry[]): {
	read: string[];
	shows: ContextShowTarget[];
	outline: string[];
	references: string[];
} {
	const read = new Set(selected.flatMap((entry) => entry.read));
	const showByKey = new Map<string, ContextShowTarget>();
	for (const entry of selected) {
		for (const target of entry.show) {
			if (read.has(target.path)) continue;
			const key = `${target.path}\0${target.name}`;
			const existing = showByKey.get(key);
			if (!existing || SHOW_RANK[target.view] > SHOW_RANK[existing.view]) showByKey.set(key, target);
		}
	}
	const shows = [...showByKey.values()].sort(
		(left, right) => left.path.localeCompare(right.path) || left.name.localeCompare(right.name),
	);
	const outline = new Set(selected.flatMap((entry) => entry.outline).filter((path) => !read.has(path)));
	const references = [
		...new Set(selected.flatMap((entry) => entry.references).filter((path) => !read.has(path) && !outline.has(path))),
	].sort((left, right) => left.localeCompare(right));
	return {
		read: [...read].sort((left, right) => left.localeCompare(right)),
		shows,
		outline: [...outline].sort((left, right) => left.localeCompare(right)),
		references,
	};
}

function contextBriefContent(selected: readonly ContextEntry[], references: readonly string[], failed: number): string {
	const authority =
		failed === 0
			? "The complete files, show targets, and outlines that follow are current. Treat them as authoritative and do not read them again. Show rows are declaration slices only — do not assume the rest of the file is loaded. Use a ranged read for bodies an outline omits, and re-read a file only after you change it."
			: "Successful complete-file, show, and outline rows that follow are current; failed rows contain no source context. Treat successful rows as authoritative and do not read them again. Show rows are declaration slices only — do not assume the rest of the file is loaded. Use a ranged read for bodies an outline omits, and re-read a file only after you change it.";
	return [
		"Active repository context, injected once from the current catalog:",
		...selected.map((entry) => `- ${entry.id}: ${entry.description}`),
		"",
		"Unloaded references:",
		...(references.length ? references.map((path) => `- ${path}`) : ["(none)"]),
		"",
		authority,
	].join("\n");
}

async function injectSelectedContext(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	root: string,
	selected: readonly ContextEntry[],
): Promise<void> {
	const plan = collectInjectionPlan(selected);
	const prepared = await prepareFileInjection(pi, {
		cwd: root,
		source: "context",
		batchId: randomUUID(),
		files: [
			...plan.read.map((path) => ({ path, mode: "full" as const })),
			...plan.shows.map((target) => ({
				path: target.path,
				mode: "show" as const,
				name: target.name,
				view: target.view,
			})),
			...plan.outline.map((path) => ({ path, mode: "outline" as const })),
		],
	});
	const failed = prepared.filter((message) => message.details.status === "failed").length;
	pi.sendMessage({
		customType: CONTEXT_BRIEF_TYPE,
		content: contextBriefContent(selected, plan.references, failed),
		display: false,
	});
	for (const message of prepared) pi.sendMessage(message);
	if (failed > 0) {
		ctx.ui.notify(
			`Injected ${prepared.length - failed} of ${prepared.length} files from ${selected.length} context entries; ${failed} failed`,
			"warning",
		);
	}
}

function hasAbortedAssistant(messages: readonly unknown[]): boolean {
	return messages.some(
		(message) =>
			typeof message === "object" &&
			message !== null &&
			"role" in message &&
			message.role === "assistant" &&
			"stopReason" in message &&
			message.stopReason === "aborted",
	);
}

async function handleAgentEndValidation(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	settings: typeof contextSettings.defaults,
	lastValidationFailure: string | undefined,
): Promise<string | undefined> {
	if (!settings.sync.enabled || !settings.validation.enabled || !ctx.isProjectTrusted()) return undefined;
	const root = await findProjectRoot(ctx.cwd);
	const git = createGitRunner(pi, ctx);
	if (!(await loadRepoStatus(git))) return lastValidationFailure;
	const failure = formatContextValidationFailure(
		await validateContextCatalog(git, root, settings.validation.ignoreGlobs),
	);
	if (!failure) return undefined;
	if (failure === lastValidationFailure) return lastValidationFailure;
	ctx.ui.notify("Context catalog validation failed; running context-sync", "error");
	const result = ctx.mode === "tui" ? await runContextSyncWithEditor(pi, ctx, {}) : await runContextSync(pi, ctx, {});
	if (!result || result.outcome === "cancelled") {
		ctx.ui.notify("Context sync cancelled", "info");
		return failure;
	}
	const afterFailure = formatContextValidationFailure(
		await validateContextCatalog(git, root, settings.validation.ignoreGlobs),
	);
	if (result.outcome === "failed" || afterFailure) {
		ctx.ui.notify(
			result.outcome === "failed" ? result.summary : "Context catalog still invalid after context-sync",
			"error",
		);
		return afterFailure ?? `${failure}\n${result.reason}`;
	}
	ctx.ui.notify(result.summary, "info");
	return undefined;
}

export default function contextExtension(pi: ExtensionAPI): void {
	let settings = contextSettings.defaults;
	let lastValidationFailure: string | undefined;
	let syncCommandRegistered = false;

	const refreshSettings = async (ctx: { cwd: string; isProjectTrusted(): boolean }) => {
		settings = await loadTauExtensionSettings(ctx, contextSettings);
		if (settings.sync.enabled) registerContextSyncCommand();
	};

	const registerContextSyncCommand = () => {
		if (syncCommandRegistered) return;
		syncCommandRegistered = true;
		pi.registerCommand("context-sync", {
			description: "Synchronize repository context from current Git changes via context-sync subagent",
			handler: async (args, ctx) => {
				if (!(await loadTauExtensionSettings(ctx, contextSettings)).sync.enabled) {
					ctx.ui.notify("Context sync is disabled in settings", "warning");
					return;
				}
				if (ctx.mode !== "tui" || !ctx.isProjectTrusted()) {
					ctx.ui.notify("/context-sync requires a trusted TUI project", "warning");
					return;
				}
				await ctx.waitForIdle();
				const result = await runContextSyncWithEditor(pi, ctx, {
					nudge: args.trim() || undefined,
				});
				if (!result) return;
				if (result.outcome === "cancelled") {
					ctx.ui.notify(result.summary, "info");
					return;
				}
				ctx.ui.notify(result.summary, result.outcome === "failed" ? "error" : "info");
			},
		});
	};

	pi.registerCommand("context", {
		description: "Inject repository context entries into the conversation",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui" || !ctx.isProjectTrusted()) {
				ctx.ui.notify("/context requires a trusted TUI project", "warning");
				return;
			}
			await ctx.waitForIdle();
			const root = await findProjectRoot(ctx.cwd);
			const entries = await loadContextEntries(root);
			if (!entries[0]) {
				ctx.ui.notify(`No context entries found in ${join(root, ".pi", "contexts")}`, "warning");
				return;
			}
			const selected = await ctx.ui.custom<ContextEntry[] | undefined>(
				(tui, theme, _keys, done) => new ContextPanel(tui, theme, entries, done),
				{
					overlay: true,
					overlayOptions: { anchor: "top-center", width: "70%", minWidth: 64, maxHeight: "80%", margin: 2 },
				},
			);
			if (selected === undefined || selected.length === 0) return;
			await injectSelectedContext(pi, ctx, root, selected);
		},
	});

	// Default on: register immediately so /context-sync exists before session_start in tests and early UI.
	if (settings.sync.enabled) registerContextSyncCommand();

	pi.on("session_start", async (_event, ctx) => {
		await refreshSettings(ctx);
	});
	pi.on("agent_start", async (_event, ctx) => {
		await refreshSettings(ctx);
	});
	pi.on("agent_end", async (event, ctx) => {
		if (hasAbortedAssistant(event.messages)) return;
		settings = await loadTauExtensionSettings(ctx, contextSettings);
		try {
			lastValidationFailure = await handleAgentEndValidation(pi, ctx, settings, lastValidationFailure);
		} catch (error) {
			ctx.ui.notify(`Context validation failed: ${error instanceof Error ? error.message : String(error)}`, "error");
		}
	});
}

async function runContextSyncWithEditor(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	options: { nudge?: string },
): Promise<ContextSyncDetails | undefined> {
	return ctx.ui.custom<ContextSyncDetails | undefined>((tui, theme, _keys, done) => {
		const panel = new ContextSyncStatusPanel(tui, theme, "Synchronizing repository context");
		void (async () => {
			try {
				const result = await runContextSync(pi, ctx, {
					nudge: options.nudge,
					signal: panel.signal,
					onStatus: (status) => {
						panel.update(status);
					},
				});
				done(result);
			} catch (error) {
				if (panel.signal.aborted) {
					done({
						outcome: "cancelled",
						summary: "Context sync cancelled",
						reason: "Cancelled by user.",
						changedContextFiles: [],
					});
					return;
				}
				done({
					outcome: "failed",
					summary: `Context sync failed: ${error instanceof Error ? error.message : String(error)}`,
					reason: error instanceof Error ? error.message : String(error),
					changedContextFiles: [],
				});
			} finally {
				panel.dispose();
			}
		})();
		return panel;
	});
}
