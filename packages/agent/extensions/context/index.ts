import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { emitTauEvent } from "../../shared/events.ts";
import { createGitRunner, loadRepoStatus } from "../../shared/git.ts";
import { createInjectedContext } from "../../shared/injected-context.ts";
import { loadTauExtensionSettings } from "../../shared/settings/load.ts";
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
	let validationSettings = contextSettings.defaults.validation;
	let lastValidationFailure: string | undefined;
	const activeToolExecutions = new Map<string, { toolName: string; done: Promise<void>; complete: () => void }>();

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
			const files = [...new Set(selected.flatMap((entry) => entry.files))].sort();
			const fileSet = new Set(files);
			const anchors = [...new Set(selected.flatMap((entry) => entry.anchors))]
				.filter((path) => !fileSet.has(path))
				.sort();
			pi.sendMessage(
				createInjectedContext(
					[
						"Selected repository context:",
						...selected.map((entry) => `- ${entry.id}: ${entry.description}`),
						"",
						"Eager snapshots supplied through autoread:",
						...(files.length ? files.map((path) => `- ${path}`) : ["(none)"]),
						"",
						"Lazy navigation anchors whose contents have not been loaded:",
						...(anchors.length ? anchors.map((path) => `- ${path}`) : ["(none)"]),
						"",
						"Treat eager snapshots as authoritative current project context. Do not reread them or search for coverage around them. Inspect only the anchors needed for the request, using grep or bounded reads. Explore elsewhere only when the request or concrete evidence requires missing information.",
					].join("\n"),
					{ source: "context", title: "Project context" },
				),
			);
			if (files.length)
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
			description:
				"Synchronize repository context membership after context validation reports changed, stale, or unassigned files.",
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
		validationSettings = (await loadTauExtensionSettings(ctx, contextSettings)).validation;
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
		for (const execution of activeToolExecutions.values()) execution.complete();
		activeToolExecutions.clear();
	});
}
