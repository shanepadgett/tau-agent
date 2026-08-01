import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getKeybindings } from "@earendil-works/pi-tui";
import { createGitRunner, loadRepoStatus } from "../../shared/git.ts";
import { loadTauExtensionSettings } from "../../shared/settings/load.ts";
import { prepareFileInjection } from "@shanepadgett/tau-agent";
import { ContextPanel, ContextSyncStatusPanel } from "./panel.ts";
import { findProjectRoot, loadContextEntries, type ContextEntry } from "./definitions.ts";
import { hideContextSyncEvidenceTool, registerContextSyncEvidenceTool } from "./evidence.ts";
import contextSettings from "./settings.ts";
import { runContextSync } from "./sync.ts";
import { formatContextValidationFailure, validateContextCatalog } from "./validation.ts";

const CONTEXT_BRIEF_TYPE = "tau.context.brief";

export default function contextExtension(pi: ExtensionAPI): void {
	let settings = contextSettings.defaults;
	let lastValidationFailure: string | undefined;
	let syncCommandRegistered = false;

	registerContextSyncEvidenceTool(pi);

	const refreshSettings = async (ctx: { cwd: string; isProjectTrusted(): boolean }) => {
		settings = await loadTauExtensionSettings(ctx, contextSettings);
		if (settings.sync.enabled) registerContextSyncCommand();
		hideContextSyncEvidenceTool(pi);
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
				const controller = new AbortController();
				const widget = showContextSyncWidget(ctx);
				const stopListening = ctx.ui.onTerminalInput((data) => {
					if (!getKeybindings().matches(data, "tui.select.cancel")) return;
					if (!controller.signal.aborted) widget.update("Cancelling context sync");
					controller.abort();
					return { consume: true };
				});
				try {
					const result = await runContextSync(pi, ctx, {
						nudge: args.trim() || undefined,
						signal: controller.signal,
						onStatus: (status) => {
							widget.update(status);
						},
					});
					if (controller.signal.aborted) {
						ctx.ui.notify("Context sync cancelled", "info");
						return;
					}
					const level = result.outcome === "failed" ? "error" : "info";
					ctx.ui.notify(result.summary, level);
				} catch (error) {
					ctx.ui.notify(
						controller.signal.aborted
							? "Context sync cancelled"
							: `Context sync failed: ${error instanceof Error ? error.message : String(error)}`,
						controller.signal.aborted ? "info" : "error",
					);
				} finally {
					stopListening();
					widget.clear();
				}
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

			// read wins over outline wins over references, so one path is injected once.
			const read = new Set(selected.flatMap((entry) => entry.read));
			const outline = new Set(selected.flatMap((entry) => entry.outline).filter((path) => !read.has(path)));
			const references = [
				...new Set(
					selected.flatMap((entry) => entry.references).filter((path) => !read.has(path) && !outline.has(path)),
				),
			].sort((left, right) => left.localeCompare(right));

			const prepared = await prepareFileInjection(pi, {
				cwd: root,
				source: "context",
				batchId: randomUUID(),
				files: [
					...[...read]
						.sort((left, right) => left.localeCompare(right))
						.map((path) => ({ path, mode: "full" as const })),
					...[...outline]
						.sort((left, right) => left.localeCompare(right))
						.map((path) => ({ path, mode: "outline" as const })),
				],
			});
			const failed = prepared.filter((message) => message.details.status === "failed").length;
			pi.sendMessage({
				customType: CONTEXT_BRIEF_TYPE,
				content: [
					"Active repository context, injected once from the current catalog:",
					...selected.map((entry) => `- ${entry.id}: ${entry.description}`),
					"",
					"Unloaded references:",
					...(references.length ? references.map((path) => `- ${path}`) : ["(none)"]),
					"",
					failed === 0
						? "The complete files and outlines that follow are current. Treat them as authoritative and do not read them again. Use a ranged read for bodies an outline omits, and re-read a file only after you change it."
						: "Successful complete-file and outline rows that follow are current; failed rows contain no source context. Treat successful rows as authoritative and do not read them again. Use a ranged read for bodies an outline omits, and re-read a file only after you change it.",
				].join("\n"),
				display: false,
			});
			for (const message of prepared) pi.sendMessage(message);
			if (failed > 0) {
				ctx.ui.notify(
					`Injected ${prepared.length - failed} of ${prepared.length} files from ${selected.length} context entries; ${failed} failed`,
					"warning",
				);
			}
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
		if (
			event.messages.some(
				(message) =>
					typeof message === "object" &&
					message !== null &&
					"role" in message &&
					message.role === "assistant" &&
					"stopReason" in message &&
					message.stopReason === "aborted",
			)
		)
			return;
		settings = await loadTauExtensionSettings(ctx, contextSettings);
		if (!settings.sync.enabled || !settings.validation.enabled || !ctx.isProjectTrusted()) {
			lastValidationFailure = undefined;
			return;
		}
		try {
			const root = await findProjectRoot(ctx.cwd);
			const git = createGitRunner(pi, ctx);
			if (!(await loadRepoStatus(git))) return;
			const failure = formatContextValidationFailure(
				await validateContextCatalog(git, root, settings.validation.ignoreGlobs),
			);
			if (!failure) {
				lastValidationFailure = undefined;
				return;
			}
			// Same unresolved failure fingerprint: do not re-spawn until the dirty/catalog signal changes.
			if (failure === lastValidationFailure) return;
			lastValidationFailure = failure;
			ctx.ui.notify("Context catalog validation failed; running context-sync", "error");
			const widget = showContextSyncWidget(ctx);
			try {
				const result = await runContextSync(pi, ctx, {
					onStatus: (status) => {
						widget.update(status);
					},
				});
				const afterFailure = formatContextValidationFailure(
					await validateContextCatalog(git, root, settings.validation.ignoreGlobs),
				);
				if (result.outcome === "failed" || afterFailure) {
					lastValidationFailure = afterFailure ?? `${failure}\n${result.reason}`;
					ctx.ui.notify(
						result.outcome === "failed" ? result.summary : "Context catalog still invalid after context-sync",
						"error",
					);
					return;
				}
				lastValidationFailure = undefined;
				ctx.ui.notify(result.summary, "info");
			} finally {
				widget.clear();
			}
		} catch (error) {
			ctx.ui.notify(`Context validation failed: ${error instanceof Error ? error.message : String(error)}`, "error");
		}
	});
}

function showContextSyncWidget(ctx: ExtensionContext): { update(status: string): void; clear(): void } {
	let widget: ContextSyncStatusPanel | undefined;
	ctx.ui.setWidget("context-sync", (tui, theme) => {
		widget = new ContextSyncStatusPanel(tui, theme, "Synchronizing repository context");
		return widget;
	});
	return {
		update(status) {
			widget?.update(status);
		},
		clear() {
			widget?.dispose();
			ctx.ui.setWidget("context-sync", undefined);
			widget = undefined;
		},
	};
}
