import { defineTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createToolRowStateStore } from "../../shared/tool-row-state.js";
import { discoverAgents, type AgentDefinition, type AgentDiscovery } from "./agents.ts";
import { renderSubagentCall, renderSubagentResult } from "./render.ts";
import {
	createSubagentThread,
	disposeSubagentThread,
	extensionPathsForTools,
	FifoGate,
	runSubagentTurn,
	type SubagentDetails,
	type SubagentThread,
} from "./run.ts";

const params = Type.Union([
	Type.Object(
		{ agent: Type.String({ minLength: 1 }), task: Type.String({ minLength: 1 }) },
		{ additionalProperties: false },
	),
	Type.Object(
		{ thread: Type.String({ minLength: 1 }), task: Type.String({ minLength: 1 }) },
		{ additionalProperties: false },
	),
]);

const MAX_RETAINED_THREADS = 16;

function emptyDetails(
	agent: string,
	task: string,
	status: "waiting" | "failed" | "aborted",
	phase: "discovery" | "queue" | "startup",
	model: string,
	thinkingLevel: string,
	threadId: string | undefined,
	error: string | undefined,
): SubagentDetails {
	return {
		agent,
		...(threadId === undefined ? {} : { threadId }),
		status,
		phase,
		task,
		model,
		thinkingLevel,
		toolCalls: 0,
		actions: [],
		omittedActions: 0,
		omittedErrors: 0,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
		durationMs: 0,
		...(error === undefined ? {} : { error }),
	};
}

export default function subagentExtension(pi: ExtensionAPI): void {
	const gate = new FifoGate(4);
	const controllers = new Set<AbortController>();
	const threads = new Map<string, SubagentThread>();
	const fingerprints = new Map<string, string>();
	const runtimeWarnings = new Set<string>();
	let nextThreadId = 1;
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
	const disposeThreads = async () => {
		const retained = [...threads.values()];
		threads.clear();
		await Promise.all(retained.map((thread) => disposeSubagentThread(thread)));
	};
	pi.on("before_agent_start", async (event, ctx) => {
		if (!pi.getActiveTools().includes("subagent")) return undefined;
		const discovery = await discoverAgents(ctx.cwd, ctx.isProjectTrusted());
		warn(discovery, ctx);
		const lines = [...discovery.agents.values()]
			.sort((a, b) => a.name.localeCompare(b.name))
			.map((agent) => `- ${agent.name}: ${agent.description}`);
		const activeThreads = [...threads.values()]
			.filter((thread) => thread.cwd === ctx.cwd)
			.sort((a, b) => a.id.localeCompare(b.id))
			.map((thread) => {
				const task = thread.initialTask.replace(/\s+/g, " ").trim();
				return `- ${thread.id} (${thread.definition.name}): ${task.length <= 160 ? task : `${task.slice(0, 159)}…`}`;
			});
		const threadSection = activeThreads.length ? `\n\nActive reusable threads:\n${activeThreads.join("\n")}` : "";
		const prompt = `## Subagents
Use \`subagent\` when an available agent matches a focused part of the task.

Available agents for this turn:
${lines.join("\n")}

Start a fresh thread with \`agent\` and \`task\`. Continue an existing thread with \`thread\` and \`task\`. Reuse a thread when feedback or follow-up work depends on its prior reads and reasoning. Start fresh for unrelated work or when its context is stale or oversized.${threadSection}

Delegate one focused task per call. Children do not inherit parent messages. Include exact absolute reference paths when a child must inspect a repository outside the current working directory.`;
		return { systemPrompt: `${event.systemPrompt}\n\n${prompt}` };
	});
	pi.registerTool(
		defineTool<typeof params, SubagentDetails>({
			name: "subagent",
			label: "Subagent",
			description:
				"Start a focused isolated child agent or continue a retained child thread. Output is limited to 50KB or 2,000 lines.",
			promptSnippet: "Start a focused child agent or continue a retained child thread",
			parameters: params,
			executionMode: "parallel",
			async execute(_id, raw, signal, onUpdate, ctx) {
				const task = raw.task.trim();
				const continuing = "thread" in raw;
				const parentModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unavailable";
				const parentThinking = pi.getThinkingLevel();
				let thread: SubagentThread | undefined;
				let definition: AgentDefinition | undefined;
				let agent = continuing ? raw.thread.trim() : raw.agent.trim();
				let threadId = continuing ? raw.thread.trim() : undefined;
				if (!task || !agent) {
					const error = continuing
						? "Subagent continuation requires non-empty thread and task"
						: "Subagent input requires non-empty agent and task";
					return {
						content: [{ type: "text", text: error }],
						details: emptyDetails(agent, task, "failed", "queue", parentModel, parentThinking, threadId, error),
					};
				}
				if (continuing) {
					thread = threads.get(agent);
					if (!thread || thread.cwd !== ctx.cwd) {
						const names =
							[...threads.values()]
								.filter((item) => item.cwd === ctx.cwd)
								.map((item) => item.id)
								.sort()
								.join(", ") || "none";
						const error = `Subagent thread ${agent} is unavailable. Active threads: ${names}`;
						return {
							content: [{ type: "text", text: error }],
							details: emptyDetails(
								agent,
								task,
								"failed",
								"discovery",
								parentModel,
								parentThinking,
								agent,
								error,
							),
						};
					}
					agent = thread.definition.name;
					threadId = thread.id;
					definition = thread.definition;
				} else {
					const discovery = await discoverAgents(ctx.cwd, ctx.isProjectTrusted());
					warn(discovery, ctx);
					definition = discovery.agents.get(agent);
					const invalid = discovery.invalid.get(agent);
					if (!definition) {
						const reason = invalid?.map((item) => item.reason).join("; ") ?? "unknown agent";
						const names = [...discovery.agents.keys()].sort().join(", ") || "none";
						const error = `Agent ${agent} discovery failed: ${reason}. Runnable agents: ${names}`;
						return {
							content: [{ type: "text", text: error }],
							details: emptyDetails(
								agent,
								task,
								"failed",
								"discovery",
								parentModel,
								parentThinking,
								undefined,
								error,
							),
						};
					}
					threadId = `thread-${nextThreadId++}`;
				}
				const controller = new AbortController();
				controllers.add(controller);
				const combined = AbortSignal.any([controller.signal, ...(signal ? [signal] : [])]);
				let releaseThread: (() => void) | undefined;
				let releaseGlobal: (() => void) | undefined;
				let reservedThread: SubagentThread | undefined;
				let phase: "queue" | "startup" = "queue";
				try {
					const waiting = emptyDetails(
						agent,
						task,
						"waiting",
						"queue",
						thread?.model ?? parentModel,
						thread?.thinkingLevel ?? parentThinking,
						threadId,
						undefined,
					);
					await onUpdate?.({ content: [{ type: "text", text: `${agent}: waiting` }], details: waiting });
					if (thread) {
						reservedThread = thread;
						thread.pendingTurns += 1;
						releaseThread = await thread.turnGate.acquire(combined);
					}
					releaseGlobal = await gate.acquire(combined);
					if (!thread) {
						phase = "startup";
						if (!threadId || !definition) throw new Error("Subagent startup state is incomplete");
						const selectedDefinition = definition;
						if (threads.size >= MAX_RETAINED_THREADS) {
							const evicted = [...threads.values()]
								.filter((item) => item.pendingTurns === 0)
								.sort((a, b) => a.lastUsedAt - b.lastUsedAt)[0];
							if (!evicted) throw new Error("Subagent thread limit reached while all retained threads are busy");
							threads.delete(evicted.id);
							await disposeSubagentThread(evicted);
						}
						thread = await createSubagentThread({
							id: threadId,
							definition: selectedDefinition,
							extensionPaths: extensionPathsForTools(pi, selectedDefinition.tools),
							initialTask: task,
							ctx,
							thinkingLevel: parentThinking,
							signal: combined,
							onWarning: (warning) => {
								const message = `Subagent definition ${selectedDefinition.path}: ${warning}`;
								if (runtimeWarnings.has(message)) return;
								runtimeWarnings.add(message);
								ctx.ui.notify(message, "warning");
							},
						});
						threads.set(thread.id, thread);
						reservedThread = thread;
						thread.pendingTurns += 1;
					}
					if (!thread) throw new Error("Subagent thread startup failed");
					const result = await runSubagentTurn({
						thread,
						task,
						initial: thread.turns === 0,
						signal: combined,
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
					return {
						content: [
							{
								type: "text",
								text: `Thread: ${thread.id}\nReuse with subagent({ thread: "${thread.id}", task: "..." })\n\n${result.content}`,
							},
						],
						details: result.details,
					};
				} catch (error) {
					const message = error instanceof Error ? error.message : `Agent ${agent} ${phase} failed`;
					const status = combined.aborted ? "aborted" : "failed";
					const details = emptyDetails(
						agent,
						task,
						status,
						phase,
						thread?.model ?? parentModel,
						thread?.thinkingLevel ?? parentThinking,
						thread?.id ?? threadId,
						message,
					);
					return { content: [{ type: "text", text: message }], details };
				} finally {
					if (reservedThread) reservedThread.pendingTurns -= 1;
					releaseGlobal?.();
					releaseThread?.();
					controllers.delete(controller);
				}
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
	pi.on("session_start", async () => {
		for (const controller of controllers) controller.abort();
		controllers.clear();
		await disposeThreads();
		nextThreadId = 1;
		rowState.clear();
		runtimeWarnings.clear();
	});
	pi.on("session_shutdown", async () => {
		for (const controller of controllers) controller.abort();
		controllers.clear();
		await disposeThreads();
	});
}
