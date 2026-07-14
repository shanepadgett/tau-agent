import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { emitTauEvent } from "../../shared/events.ts";
import { createGitRunner, loadRepoStatus } from "../../shared/git.ts";
import { createInjectedContext } from "../../shared/injected-context.ts";
import { loadTauExtensionSettings } from "../../shared/settings/load.ts";
import { registerTauSystemPromptContribution } from "../../shared/system-prompt-contributions.ts";
import { ContextPanel } from "./panel.ts";
import { findProjectRoot, loadContextEntries, type ContextEntry } from "./definitions.ts";
import contextSettings from "./settings.ts";
import { runContextSync, type ContextSyncDetails } from "./sync.ts";
import { formatContextValidationFailure, validateContextCatalog } from "./validation.ts";

const contextSyncParams = Type.Object({}, { additionalProperties: false });

function compactResult(details: ContextSyncDetails) {
	const value = {
		outcome: details.outcome,
		summary: details.summary,
		reason: details.reason,
		changedContextFiles: details.changedContextFiles,
	};
	return { content: [{ type: "text" as const, text: JSON.stringify(value) }], details };
}

export default function contextExtension(pi: ExtensionAPI): void {
	let active: ContextEntry[] = [];
	let validationSettings = contextSettings.defaults.validation;
	let lastValidationFailure: string | undefined;
	const activeToolExecutions = new Map<string, { toolName: string; done: Promise<void>; complete: () => void }>();
	const unregisterPrompt = registerTauSystemPromptContribution({
		id: "context.selected-authority",
		order: 100,
		render: () =>
			active.length
				? "Treat the autoread files as the authoritative project context and current snapshots. Do not reread them or search for coverage around them. Start work from them immediately. Explore outside them only when the user's request or concrete evidence in those files requires missing code or information."
				: undefined,
	});

	pi.registerCommand("context", {
		description: "Select repository context entries and inject their files",
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
			if (!selected?.length) return;
			active = selected;
			pi.appendEntry("tau.context-selection", { ids: selected.map((entry) => entry.id) });
			const files = [...new Set(selected.flatMap((entry) => entry.files))].sort();
			pi.sendMessage(
				createInjectedContext(
					"Treat the autoread files as the authoritative project context and current snapshots. Do not reread them or search for coverage around them. Start work from them immediately. Explore outside them only when the user's request or concrete evidence in those files requires missing code or information.",
					{ source: "context", title: "Project context" },
				),
			);
			emitTauEvent(pi, "tau:autoread.requested", {
				source: "context",
				title: "Project context",
				cwd: root,
				batchId: randomUUID(),
				files: files.map((path) => ({ path })),
			});
		},
	});

	pi.registerCommand("context-sync", {
		description: "Synchronize repository context from current Git changes",
		handler: async (args, ctx) => {
			if (args.trim()) {
				ctx.ui.notify("Usage: /context-sync", "warning");
				return;
			}
			if (ctx.mode !== "tui" || !ctx.isProjectTrusted()) {
				ctx.ui.notify("/context-sync requires a trusted TUI project", "warning");
				return;
			}
			await ctx.waitForIdle();
			ctx.ui.setStatus("context-sync", "synchronizing context");
			try {
				const result = await runContextSync(pi, ctx);
				ctx.ui.notify(result.summary, "info");
			} catch (error) {
				ctx.ui.notify(`Context sync failed: ${error instanceof Error ? error.message : String(error)}`, "error");
			} finally {
				ctx.ui.setStatus("context-sync", undefined);
			}
		},
	});

	pi.registerTool(
		defineTool<typeof contextSyncParams, ContextSyncDetails | undefined>({
			name: "context_sync",
			label: "context_sync",
			description: "Synchronize repository context from current Git changes.",
			parameters: contextSyncParams,
			async execute(id, _params, _signal, onUpdate, ctx) {
				await Promise.all(
					[...activeToolExecutions]
						.filter(([toolCallId, execution]) => toolCallId !== id && execution.toolName !== "context_sync")
						.map(([, execution]) => execution.done),
				);
				return compactResult(
					await runContextSync(pi, ctx, (status) =>
						onUpdate?.({ content: [{ type: "text", text: status }], details: undefined }),
					),
				);
			},
			renderCall(_args, theme, context) {
				const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
				text.setText(theme.fg("toolTitle", "context_sync"));
				return text;
			},
			renderResult(result, options, theme, context) {
				const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
				const details = result.details;
				const output = result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
				text.setText(
					options.isPartial
						? theme.fg("dim", output)
						: context.expanded && details
							? [
									details.summary,
									details.reason,
									...details.changes.map((change) =>
										change.action === "set-entry"
											? `${change.action} ${change.tab}/${change.concept}/${change.entry}: ${change.files.join(", ")}`
											: `${change.action} ${change.tab}/${change.concept}/${change.entry}`,
									),
									...details.changedContextFiles,
								].join("\n")
							: (details?.summary ?? theme.fg("error", output)),
				);
				return text;
			},
		}),
	);

	pi.on("tool_execution_start", (event) => {
		let complete = () => {};
		const done = new Promise<void>((resolve) => {
			complete = resolve;
		});
		activeToolExecutions.set(event.toolCallId, { toolName: event.toolName, done, complete });
	});

	pi.on("tool_execution_end", (event) => {
		const execution = activeToolExecutions.get(event.toolCallId);
		activeToolExecutions.delete(event.toolCallId);
		execution?.complete();
	});

	pi.on("session_start", async (_event, ctx) => {
		const root = await findProjectRoot(ctx.cwd);
		const [entries, settings] = await Promise.all([
			loadContextEntries(root),
			loadTauExtensionSettings(ctx, contextSettings),
		]);
		validationSettings = settings.validation;
		let selectionData: unknown;
		for (const entry of ctx.sessionManager.getBranch())
			if (entry.type === "custom" && entry.customType === "tau.context-selection") selectionData = entry.data;
		const ids =
			typeof selectionData === "object" &&
			selectionData !== null &&
			"ids" in selectionData &&
			Array.isArray(selectionData.ids)
				? selectionData.ids.filter((id: unknown): id is string => typeof id === "string")
				: [];
		active = entries.filter((entry) => ids.includes(entry.id));
	});
	pi.on("agent_start", async (_event, ctx) => {
		validationSettings = (await loadTauExtensionSettings(ctx, contextSettings)).validation;
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
		if (!validationSettings.enabled || !ctx.isProjectTrusted()) {
			lastValidationFailure = undefined;
			return;
		}
		try {
			const root = await findProjectRoot(ctx.cwd);
			const git = createGitRunner(pi, ctx);
			if (!(await loadRepoStatus(git))) return;
			const failure = formatContextValidationFailure(
				await validateContextCatalog(git, root, validationSettings.ignoreGlobs),
			);
			if (!failure) {
				lastValidationFailure = undefined;
				return;
			}
			if (failure === lastValidationFailure) return;
			lastValidationFailure = failure;
			ctx.ui.notify("Context catalog validation failed", "error");
			pi.sendMessage(
				{ customType: "tau.context-validation", content: failure, display: false },
				{ triggerTurn: true },
			);
		} catch (error) {
			ctx.ui.notify(`Context validation failed: ${error instanceof Error ? error.message : String(error)}`, "error");
		}
	});
	pi.on("session_shutdown", () => {
		unregisterPrompt();
		for (const execution of activeToolExecutions.values()) execution.complete();
		activeToolExecutions.clear();
	});
}
