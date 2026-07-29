import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getKeybindings } from "@earendil-works/pi-tui";
import { createGitRunner, loadRepoStatus } from "../../shared/git.ts";
import { loadTauExtensionSettings } from "../../shared/settings/load.ts";
import { ContextPanel, ContextSyncStatusPanel } from "./panel.ts";
import { findProjectRoot, loadContextEntries, type ContextEntry } from "./definitions.ts";
import { hideContextSyncEvidenceTool, registerContextSyncEvidenceTool } from "./evidence.ts";
import {
	buildContextProjection,
	contextProjectionKey,
	contextProjectionMessage,
	removeLegacyContextMessages,
	selectContextEntries,
} from "./projection.ts";
import contextSettings from "./settings.ts";
import { CONTEXT_SELECTION_TYPE, createContextSelectionState, replayContextSelection } from "./state.ts";
import { runContextSync } from "./sync.ts";
import { formatContextValidationFailure, validateContextCatalog } from "./validation.ts";

export default function contextExtension(pi: ExtensionAPI): void {
	let settings = contextSettings.defaults;
	let lastValidationFailure: string | undefined;
	let syncCommandRegistered = false;
	let lifecycleGeneration = 0;
	let projectionCache: { key: string; content: string } | undefined;

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
		description: "Select active repository context entries",
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
			const active = replayContextSelection(ctx.sessionManager.getBranch()).entryIds;
			const selected = await ctx.ui.custom<ContextEntry[] | undefined>(
				(tui, theme, _keys, done) => new ContextPanel(tui, theme, entries, active, done),
				{
					overlay: true,
					overlayOptions: { anchor: "top-center", width: "70%", minWidth: 64, maxHeight: "80%", margin: 2 },
				},
			);
			if (selected === undefined) return;
			pi.appendEntry(CONTEXT_SELECTION_TYPE, createContextSelectionState(selected.map((entry) => entry.id)));
			projectionCache = undefined;
			ctx.ui.notify(
				selected.length ? `${selected.length} context entries active` : "Active context cleared",
				"info",
			);
		},
	});

	// Default on: register immediately so /context-sync exists before session_start in tests and early UI.
	if (settings.sync.enabled) registerContextSyncCommand();

	pi.on("session_start", async (_event, ctx) => {
		lifecycleGeneration += 1;
		projectionCache = undefined;
		await refreshSettings(ctx);
	});
	pi.on("context", async (event, ctx) => {
		const messages = removeLegacyContextMessages(event.messages);
		if (!ctx.isProjectTrusted()) return { messages };
		const entryIds = replayContextSelection(ctx.sessionManager.getBranch()).entryIds;
		if (entryIds.length === 0) return { messages };
		const generation = lifecycleGeneration;
		const root = await findProjectRoot(ctx.cwd);
		const selection = selectContextEntries(await loadContextEntries(root), entryIds);
		const key = await contextProjectionKey(root, selection, ctx.signal, () => generation === lifecycleGeneration);
		if (generation !== lifecycleGeneration) return { messages };
		if (projectionCache?.key !== key) {
			projectionCache = {
				key,
				content: await buildContextProjection(
					pi,
					root,
					selection,
					ctx.signal,
					() => generation === lifecycleGeneration,
				),
			};
		}
		return { messages: [...messages, contextProjectionMessage(projectionCache.content)] };
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
	pi.on("session_tree", () => {
		lifecycleGeneration += 1;
		projectionCache = undefined;
	});
	pi.on("session_compact", () => {
		lifecycleGeneration += 1;
		projectionCache = undefined;
	});
	pi.on("session_shutdown", () => {
		lifecycleGeneration += 1;
		projectionCache = undefined;
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
			ctx.ui.setWidget("context-sync", undefined);
			widget = undefined;
		},
	};
}
