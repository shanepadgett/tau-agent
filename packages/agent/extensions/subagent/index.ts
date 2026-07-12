import { defineTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createToolRowStateStore } from "../../shared/tool-row-state.js";
import { discoverAgents, type AgentDiscovery } from "./agents.ts";
import { renderSubagentCall, renderSubagentResult } from "./render.ts";
import { extensionPathsForTools, FifoGate, runSubagent, type SubagentDetails } from "./run.ts";

const params = Type.Object(
	{ agent: Type.String({ minLength: 1 }), task: Type.String({ minLength: 1 }) },
	{ additionalProperties: false },
);

export default function subagentExtension(pi: ExtensionAPI): void {
	const gate = new FifoGate(4);
	const controllers = new Set<AbortController>();
	const fingerprints = new Map<string, string>();
	const runtimeWarnings = new Set<string>();
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
	pi.registerTool(
		defineTool<typeof params, SubagentDetails>({
			name: "subagent",
			label: "Subagent",
			description:
				"Delegate one focused task to a named isolated child agent. Output is limited to 50KB or 2,000 lines.",
			promptSnippet: "Delegate one focused task to a named isolated child agent",
			parameters: params,
			executionMode: "parallel",
			async execute(_id, raw, signal, onUpdate, ctx) {
				const agent = raw.agent.trim();
				const task = raw.task.trim();
				const thinkingLevel = pi.getThinkingLevel();
				if (!agent || !task)
					return {
						content: [{ type: "text", text: "Subagent input requires non-empty agent and task" }],
						details: {
							agent,
							task,
							status: "failed",
							phase: "queue",
							model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unavailable",
							thinkingLevel,
							toolCalls: 0,
							actions: [],
							omittedActions: 0,
							omittedErrors: 0,
							usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
							durationMs: 0,
							error: "Invalid input",
						},
					};
				const discovery = await discoverAgents(ctx.cwd, ctx.isProjectTrusted());
				warn(discovery, ctx);
				const definition = discovery.agents.get(agent);
				const invalid = discovery.invalid.get(agent);
				if (!definition) {
					const reason = invalid?.map((item) => item.reason).join("; ") ?? "unknown agent";
					const names = [...discovery.agents.keys()].sort().join(", ") || "none";
					const error = `Agent ${agent} discovery failed: ${reason}. Runnable agents: ${names}`;
					return {
						content: [{ type: "text", text: error }],
						details: {
							agent,
							task,
							status: "failed",
							phase: "discovery",
							model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unavailable",
							thinkingLevel,
							toolCalls: 0,
							actions: [],
							omittedActions: 0,
							omittedErrors: 0,
							usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
							durationMs: 0,
							error,
						},
					};
				}
				const controller = new AbortController();
				controllers.add(controller);
				const combined = AbortSignal.any([controller.signal, ...(signal ? [signal] : [])]);
				let release: (() => void) | undefined;
				try {
					await onUpdate?.({
						content: [{ type: "text", text: `${agent}: waiting` }],
						details: {
							agent,
							task,
							status: "waiting",
							phase: "queue",
							model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unavailable",
							thinkingLevel,
							toolCalls: 0,
							actions: [],
							omittedActions: 0,
							omittedErrors: 0,
							usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
							durationMs: 0,
						},
					});
					try {
						release = await gate.acquire(combined);
					} catch (error) {
						const message = error instanceof Error ? error.message : `Agent ${agent} queue failed`;
						const details: SubagentDetails = {
							agent,
							task,
							status: combined.aborted ? "aborted" : "failed",
							phase: "queue",
							model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unavailable",
							thinkingLevel,
							toolCalls: 0,
							actions: [],
							omittedActions: 0,
							omittedErrors: 0,
							usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
							durationMs: 0,
							error: message,
						};
						return { content: [{ type: "text", text: message }], details };
					}
					const result = await runSubagent({
						definition,
						extensionPaths: extensionPathsForTools(pi, definition.tools),
						task,
						ctx,
						thinkingLevel,
						signal: combined,
						onWarning: (warning) => {
							const message = `Subagent definition ${definition.path}: ${warning}`;
							if (runtimeWarnings.has(message)) return;
							runtimeWarnings.add(message);
							ctx.ui.notify(message, "warning");
						},
						onUpdate: (details) =>
							onUpdate?.({
								content: [
									{
										type: "text",
										text: details.currentActivity ?? details.response ?? `${agent}: ${details.status}`,
									},
								],
								details,
							}),
					});
					return { content: [{ type: "text", text: result.content }], details: result.details };
				} finally {
					release?.();
					controllers.delete(controller);
				}
			},
			renderCall(args, theme, context) {
				return renderSubagentCall(args, theme, {
					executionStarted: context.executionStarted,
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
	pi.on("before_agent_start", async (event, ctx) => {
		if (!pi.getActiveTools().includes("subagent")) return;
		const discovery = await discoverAgents(ctx.cwd, ctx.isProjectTrusted());
		warn(discovery, ctx);
		const lines = [...discovery.agents.values()]
			.sort((a, b) => a.name.localeCompare(b.name))
			.map((agent) => `- ${agent.name}: ${agent.description}`);
		const prompt = `## Subagents\nUse \`subagent\` when an available agent matches a focused part of the task.\n\nAvailable agents for this turn:\n${lines.join("\n")}\n\nDelegate one focused task per call. Children do not inherit parent messages. Include exact absolute reference paths when a child must inspect a repository outside the current working directory.`;
		event.systemPromptOptions.appendSystemPrompt = event.systemPromptOptions.appendSystemPrompt
			? `${event.systemPromptOptions.appendSystemPrompt}\n\n${prompt}`
			: prompt;
		return {
			systemPrompt: `${event.systemPrompt}\n\n${prompt}`,
		};
	});
	pi.on("tool_result", (event) => {
		if (event.toolName !== "subagent") return;
		const details = event.details as SubagentDetails | undefined;
		if (details?.status === "failed" || details?.status === "aborted") return { isError: true };
	});
	pi.on("session_start", () => {
		rowState.clear();
		runtimeWarnings.clear();
	});
	pi.on("session_shutdown", () => {
		for (const controller of controllers) controller.abort();
		controllers.clear();
	});
}
