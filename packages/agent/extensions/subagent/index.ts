import { rm } from "node:fs/promises";
import { defineTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { loadTauExtensionSettings } from "../../shared/settings/load.ts";
import { createToolRowStateStore } from "../../shared/tool-row-state.js";
import contextSettings from "../context/settings.ts";
import { discoverAgents, type AgentDiscovery } from "./agents.ts";
import { createCmuxDashboard, type CmuxDashboard, type DashboardOrphan } from "./cmux-dashboard.ts";
import { createAgentsPanel } from "./panel.ts";
import { renderSubagentCall, renderSubagentResult } from "./render.ts";
import type { SubagentDetails } from "./run.ts";
import { failedToolResult, SubagentRuntime } from "./runtime.ts";
import subagentSettings from "./settings.ts";

interface SubagentSessionState {
	disabled: string[];
}

const SUBAGENT_SESSION_STATE_TYPE = "tau.subagent.disabled";

const params = Type.Union([
	Type.Object(
		{
			agent: Type.String({ minLength: 1 }),
			task: Type.String({ minLength: 1 }),
			files: Type.Optional(
				Type.Array(Type.String({ minLength: 1 }), {
					description: "Files to autoread into the child's context before this turn",
				}),
			),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			thread: Type.String({ minLength: 1 }),
			task: Type.String({ minLength: 1 }),
			files: Type.Optional(
				Type.Array(Type.String({ minLength: 1 }), {
					description: "Files to autoread into the child's context before this turn",
				}),
			),
		},
		{ additionalProperties: false },
	),
]);

export default function subagentExtension(pi: ExtensionAPI): void {
	const runtime = new SubagentRuntime(pi);
	let sessionDisabled = new Set<string>();
	let failureNotify: ((message: string) => void) | undefined;
	const orphans: DashboardOrphan[] = [];
	const retryOrphans = async () => {
		if (orphans.length === 0) return;
		const pending = orphans.splice(0, orphans.length);
		for (const orphan of pending) {
			if (orphan.surfaceId && orphan.workspaceId) {
				const result = await pi
					.exec(
						"cmux",
						[
							"--json",
							"--id-format",
							"both",
							"rpc",
							"surface.close",
							JSON.stringify({ workspace_id: orphan.workspaceId, surface_id: orphan.surfaceId }),
						],
						{ timeout: 2500 },
					)
					.catch(() => ({ stdout: "", stderr: "close failed", code: 1, killed: false }));
				const closed =
					(result.code === 0 && !result.killed) ||
					/not found|unknown surface|no such/i.test(`${result.stderr}\n${result.stdout}`);
				if (!closed) {
					orphans.push(orphan);
					continue;
				}
			}
			// Known-closed or never had a surface id after ambiguous open: drop directory only when closed/absent.
			// Ambiguous no-id orphans stay on disk; keep tracking so we do not open more without awareness.
			if (orphan.surfaceId) {
				await rm(orphan.directory, { recursive: true, force: true }).catch(() => undefined);
			} else {
				orphans.push(orphan);
			}
		}
	};
	const makeDashboard = () =>
		createCmuxDashboard({
			exec: (command, args, options) => pi.exec(command, args, options),
			canOpen: () => orphans.length === 0,
			notify: (message) => {
				try {
					failureNotify?.(message);
				} catch {
					// ignore
				}
			},
		});
	let dashboard: CmuxDashboard = makeDashboard();
	let unsubscribeDashboard = runtime.subscribe((snapshot) => {
		dashboard.onSnapshot(snapshot);
	});
	const replaceDashboard = async () => {
		unsubscribeDashboard();
		const leftover = await dashboard.shutdown();
		orphans.push(...leftover);
		await retryOrphans();
		dashboard = makeDashboard();
		unsubscribeDashboard = runtime.subscribe((snapshot) => {
			dashboard.onSnapshot(snapshot);
		});
	};
	const fingerprints = new Map<string, string>();
	const rowState = createToolRowStateStore(pi, "subagent.tool-row-state");
	const warn = (discovery: AgentDiscovery, ctx: ExtensionContext) => {
		const current = new Set<string>();
		const grouped = new Map<string, string[]>();
		for (const diagnostic of discovery.diagnostics) {
			const reasons = grouped.get(diagnostic.path) ?? [];
			reasons.push(diagnostic.reason);
			grouped.set(diagnostic.path, reasons);
		}
		for (const [path, reasons] of grouped) {
			current.add(path);
			const fingerprint = [...reasons].sort().join("\0");
			if (fingerprints.get(path) !== fingerprint)
				ctx.ui.notify(`Invalid subagent definition ${path}: ${reasons.join("; ").slice(0, 500)}`, "warning");
			fingerprints.set(path, fingerprint);
		}
		for (const path of fingerprints.keys()) if (!current.has(path)) fingerprints.delete(path);
	};
	const disabledAgentNames = async (ctx: ExtensionContext) => {
		const configured = new Set((await loadTauExtensionSettings(ctx, subagentSettings)).disabled);
		return { configured, effective: new Set([...configured, ...sessionDisabled]) };
	};
	const parentVisibleAgents = async (ctx: ExtensionContext, discovery: AgentDiscovery) => {
		const [sync, disabled] = await Promise.all([
			loadTauExtensionSettings(ctx, contextSettings).then((settings) => settings.sync),
			disabledAgentNames(ctx),
		]);
		const parentVisible = sync.enabled && sync.automation;
		return [...discovery.agents.values()]
			.filter((agent) => !disabled.effective.has(agent.name) && (agent.name !== "context-sync" || parentVisible))
			.sort((a, b) => a.name.localeCompare(b.name));
	};
	const restoreSessionState = (ctx: ExtensionContext) => {
		let saved: string[] | undefined;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== SUBAGENT_SESSION_STATE_TYPE) continue;
			const data = entry.data as { disabled?: unknown } | undefined;
			if (Array.isArray(data?.disabled)) {
				saved = data.disabled.filter((name): name is string => typeof name === "string" && name.length > 0);
			}
		}
		sessionDisabled = new Set(saved ?? []);
	};

	pi.registerCommand("agents", {
		description: "Enable/disable subagents for this session",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/agents requires TUI mode", "error");
				return;
			}

			const [discovery, disabled] = await Promise.all([
				discoverAgents(ctx.cwd, ctx.isProjectTrusted()),
				disabledAgentNames(ctx),
			]);
			warn(discovery, ctx);
			const agents = [...discovery.agents.values()].sort((a, b) => a.name.localeCompare(b.name));
			if (agents.length === 0) {
				ctx.ui.notify("No valid subagents found", "warning");
				return;
			}

			await ctx.ui.custom((tui, theme, _keybindings, done) =>
				createAgentsPanel(
					tui,
					theme,
					agents.map((agent) => ({
						id: agent.name,
						disabled: disabled.effective.has(agent.name),
						configured: disabled.configured.has(agent.name),
					})),
					(disabledNames) => {
						for (const agent of agents) {
							if (!disabled.configured.has(agent.name)) sessionDisabled.delete(agent.name);
						}
						for (const name of disabledNames) sessionDisabled.add(name);
						pi.appendEntry<SubagentSessionState>(SUBAGENT_SESSION_STATE_TYPE, {
							disabled: [...sessionDisabled].sort(),
						});
					},
					() => done(undefined),
				),
			);
		},
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (!pi.getActiveTools().includes("subagent")) return undefined;
		const discovery = await discoverAgents(ctx.cwd, ctx.isProjectTrusted());
		warn(discovery, ctx);
		const lines = (await parentVisibleAgents(ctx, discovery)).map((agent) => `- ${agent.name}: ${agent.description}`);
		const prompt = `## Subagents
Use \`subagent\` when an available agent matches a focused part of the task.

Available agents for this turn:
${lines.join("\n")}

Start a fresh thread with \`agent\` and \`task\`. Continue an existing thread with \`thread\` and \`task\`. Reuse a thread when feedback or follow-up work depends on its prior reads and reasoning. Start fresh for unrelated work or when its context is stale or oversized.

Pass \`files\` when exact relevant files are already known. Tau autoreads current line-numbered snapshots into that child turn before it starts.

Delegate one focused task per call. Children do not inherit parent messages. Include exact absolute reference paths when a child must inspect a repository outside the current working directory.

Scout only for substantial multi-hop lookup that would flood parent context. Skip few known-path reads, single declaration lookups, or small digs with most evidence already in hand; use tools directly. When uncertain, dig yourself.`;
		return { systemPrompt: `${event.systemPrompt}\n\n${prompt}` };
	});
	pi.registerTool(
		defineTool<typeof params, SubagentDetails>({
			name: "subagent",
			label: "Subagent",
			description:
				"Start a focused isolated child agent or continue a retained child thread. Known files can be autoread into the child turn. Output is limited to 50KB or 2,000 lines.",
			promptSnippet: "Start a focused child agent or continue a retained child thread",
			parameters: params,
			executionMode: "parallel",
			async execute(_id, raw, signal, onUpdate, ctx) {
				const task = raw.task.trim();
				const files = [...new Set((raw.files ?? []).map((path) => path.trim()))];
				const continuing = "thread" in raw;
				const parentModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unavailable";
				const parentThinking = pi.getThinkingLevel();
				const agent = continuing ? raw.thread.trim() : raw.agent.trim();
				const threadKey = continuing ? raw.thread.trim() : undefined;

				failureNotify = (message) => {
					ctx.ui.notify(message, "warning");
				};
				dashboard.setInteractive(ctx.mode === "tui" && ctx.hasUI);

				if (!task || !agent || files.some((path) => !path)) {
					const error = continuing
						? "Subagent continuation requires non-empty thread, task, and file paths"
						: "Subagent input requires non-empty agent, task, and file paths";
					return failedToolResult(agent, task, "queue", parentModel, parentThinking, error, threadKey);
				}

				if (continuing) {
					const thread = runtime.listThreads(ctx.cwd).find((item) => item.id === threadKey);
					if (thread) {
						const disabled = await disabledAgentNames(ctx);
						if (disabled.effective.has(thread.definition.name)) {
							const source = disabled.configured.has(thread.definition.name)
								? "in Tau settings"
								: "for this session";
							return failedToolResult(
								thread.definition.name,
								task,
								"discovery",
								parentModel,
								parentThinking,
								`Agent ${thread.definition.name} is disabled ${source}.`,
								threadKey,
							);
						}
					}
				}

				return runtime.execute({
					agent,
					task,
					files,
					continuing,
					threadKey,
					ctx,
					parentModel,
					parentThinking,
					signal,
					onUpdate: (details) =>
						onUpdate?.({
							content: [
								{
									type: "text",
									text: details.currentActivity ?? details.response ?? `${details.agent}: ${details.status}`,
								},
							],
							details,
						}),
					resolveFreshDefinition: async () => {
						const discovery = await discoverAgents(ctx.cwd, ctx.isProjectTrusted());
						warn(discovery, ctx);
						const definition = discovery.agents.get(agent);
						const invalid = discovery.invalid.get(agent);
						if (!definition) {
							const reason = invalid?.map((item) => item.reason).join("; ") ?? "unknown agent";
							const names =
								(await parentVisibleAgents(ctx, discovery)).map((item) => item.name).join(", ") || "none";
							return {
								ok: false,
								phase: "discovery",
								error: `Agent ${agent} discovery failed: ${reason}. Runnable agents: ${names}`,
							};
						}
						const disabled = await disabledAgentNames(ctx);
						if (disabled.effective.has(definition.name)) {
							const source = disabled.configured.has(definition.name) ? "in Tau settings" : "for this session";
							return { ok: false, phase: "discovery", error: `Agent ${definition.name} is disabled ${source}.` };
						}
						if (definition.name === "context-sync") {
							const sync = (await loadTauExtensionSettings(ctx, contextSettings)).sync;
							if (!sync.enabled) {
								return { ok: false, phase: "discovery", error: "Context sync is disabled in settings." };
							}
							if (!sync.automation) {
								return {
									ok: false,
									phase: "discovery",
									error: "Context-sync automation is disabled. Use /context-sync or enable extensions.context.sync.automation.",
								};
							}
						}
						return { ok: true, definition };
					},
				});
			},
			renderCall(args, theme, context) {
				return renderSubagentCall(args, theme, {
					executionStarted: context.executionStarted,
					isPartial: context.isPartial,
					lastComponent: context.lastComponent,
					rowState,
					rowId: context.toolCallId,
					invalidate: context.invalidate,
				});
			},
			renderResult(result, options, theme, context) {
				return renderSubagentResult(result, options.expanded, theme, {
					lastComponent: context.lastComponent,
					rowState,
					rowId: context.toolCallId,
					invalidate: context.invalidate,
				});
			},
		}),
	);
	pi.on("tool_result", (event) => {
		if (event.toolName !== "subagent") return;
		const details = event.details as SubagentDetails | undefined;
		if (details?.status === "failed" || details?.status === "aborted") return { isError: true };
	});
	pi.on("session_start", async (_event, ctx) => {
		restoreSessionState(ctx);
		await runtime.reset();
		await replaceDashboard();
		rowState.clear();
		fingerprints.clear();
		failureNotify = undefined;
	});
	pi.on("session_tree", (_event, ctx) => {
		restoreSessionState(ctx);
	});
	pi.on("session_shutdown", async () => {
		unsubscribeDashboard();
		await runtime.shutdown();
		const leftover = await dashboard.shutdown();
		orphans.push(...leftover);
		await retryOrphans();
		rowState.clear();
		fingerprints.clear();
		failureNotify = undefined;
		sessionDisabled.clear();
	});
}
