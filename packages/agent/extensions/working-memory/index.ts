import {
	defineTool,
	type ExtensionAPI,
	type ExtensionContext,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { emitTauEvent, onTauEvent } from "../../shared/events.ts";
import { loadTauExtensionSettings } from "../../shared/settings/load.ts";
import { createToolRowStateStore } from "../../shared/tool-row-state.ts";
import { executeWorkingMemory, workingMemoryParameters } from "./checkpoint.ts";
import { projectWorkingMemory } from "./memory.ts";
import {
	parseWorkingMemoryNudge,
	renderWorkingMemoryCall,
	renderWorkingMemoryNudge,
	renderWorkingMemoryResult,
	type WorkingMemoryNudgeDetails,
} from "./render.ts";
import workingMemorySettings from "./settings.ts";
import { replayWorkingMemoryState, WORKING_MEMORY_TOOL, type WorkingMemoryCheckpointDetailsV1 } from "./state.ts";

const NUDGE_TYPE = "tau.working-memory.nudge";
const BASELINE_TYPE = "tau.working-memory.nudge-baseline";
const TOOL_DESCRIPTION =
	"Create a selective hard checkpoint for future model context. Keep valuable referenced evidence and complete tool exchanges, carry file structure as outlines, defer conditionally relevant files without reading them, and provide one compact continuation note. Never checkpoint useful evidence merely to reread it.";

interface NudgeState {
	anchorToolCallId: string | undefined;
	suppressedThroughTokens: number | undefined;
	highestBoundaryTokens: number;
}

export default function workingMemoryExtension(pi: ExtensionAPI): void {
	let enabled = false;
	let generation = 0;
	let interval = workingMemorySettings.defaults.nudgeEveryTokens;
	let instructions = workingMemorySettings.defaults.nudgeInstructions;
	let toolRegistered = false;
	let commandRegistered = false;
	let visualRows = new Set<string>();
	let nudgeState: NudgeState = { anchorToolCallId: undefined, suppressedThroughTokens: 0, highestBoundaryTokens: 0 };
	const rowState = createToolRowStateStore(pi, "working-memory.tool-row-state");

	pi.registerMessageRenderer<WorkingMemoryNudgeDetails>(NUDGE_TYPE, (message, _options, theme) =>
		renderWorkingMemoryNudge(message.details, theme),
	);

	const pushVisualSnapshot = () => {
		emitTauEvent(pi, "tau:tool-row-state.snapshot", {
			states: [...visualRows].map((rowId) => ({ rowId, state: "pruned" as const })),
		});
	};
	onTauEvent(
		pi,
		"working-memory.tool-row-state-producer",
		"tau:tool-row-state.snapshot.requested",
		pushVisualSnapshot,
	);

	const invalidate = () => {
		generation += 1;
	};
	const setToolActive = (active: boolean) => {
		if (!toolRegistered) return;
		const activeTools = pi.getActiveTools();
		const currentlyActive = activeTools.includes(WORKING_MEMORY_TOOL);
		if (active === currentlyActive) return;
		pi.setActiveTools(
			active ? [...activeTools, WORKING_MEMORY_TOOL] : activeTools.filter((name) => name !== WORKING_MEMORY_TOOL),
		);
	};
	const syncBranch = (ctx: ExtensionContext) => {
		const branch = ctx.sessionManager.getBranch();
		const state = replayWorkingMemoryState(branch, enabled);
		visualRows = new Set(state.prunedRowIds);
		nudgeState = reconstructNudgeState(branch, state.latestAnchorToolCallId);
		pushVisualSnapshot();
	};

	pi.on("session_start", async (_event, ctx) => {
		invalidate();
		enabled = false;
		setToolActive(false);
		visualRows.clear();
		pushVisualSnapshot();
		const current = generation;
		const settings = await loadTauExtensionSettings(ctx, workingMemorySettings);
		if (current !== generation) return;
		enabled = settings.enabled;
		interval = settings.nudgeEveryTokens;
		instructions = settings.nudgeInstructions;
		if (enabled && !toolRegistered) {
			pi.registerTool(
				defineTool<typeof workingMemoryParameters, WorkingMemoryCheckpointDetailsV1>({
					name: WORKING_MEMORY_TOOL,
					label: WORKING_MEMORY_TOOL,
					description: TOOL_DESCRIPTION,
					promptSnippet: "Reassess and selectively checkpoint active working memory",
					promptGuidelines: [
						"Use working_memory when stale evidence has accumulated or a memory reminder asks for reassessment; continue coherent exploration when current evidence remains useful.",
						"A hidden working-memory reference catalog provides keep refs. Message refs preserve conversational evidence; tool refs preserve one complete call/result exchange.",
						"Keep active or expensive evidence, outline files when structure suffices, defer paths whose relevance is conditional, and discard evidence with no expected value.",
						"Everything before working_memory leaves future model context unless selected in keep. Put durable decisions, constraints, unresolved matters, and next action in continuation without duplicating retained evidence.",
					],
					parameters: workingMemoryParameters,
					executionMode: "sequential",
					async execute(toolCallId, params, signal, _onUpdate, ctx) {
						const execution = await executeWorkingMemory({
							pi,
							toolCallId,
							params,
							signal,
							ctx,
							generation,
							currentGeneration: () => generation,
						});
						for (const outline of execution.outlines) pi.sendMessage(outline, { deliverAs: "steer" });
						return execution.result;
					},
					renderCall(args, theme, context) {
						return renderWorkingMemoryCall(args, theme, {
							rowState,
							rowId: context.toolCallId,
							invalidate: context.invalidate,
							lastComponent: context.lastComponent,
						});
					},
					renderResult(result, options, theme, context) {
						return renderWorkingMemoryResult(result, options.expanded, theme, context.lastComponent);
					},
				}),
			);
			toolRegistered = true;
		}
		setToolActive(enabled);
		if (enabled && !commandRegistered) {
			pi.registerCommand("prune", {
				description: "Ask agent to reassess working memory and continue",
				async handler(args, commandContext) {
					if (!enabled) {
						commandContext.ui.notify("Working memory is disabled.", "info");
						return;
					}
					if (args.trim().length > 0) {
						commandContext.ui.notify("Usage: /prune", "info");
						return;
					}
					const anchor = replayWorkingMemoryState(
						commandContext.sessionManager.getBranch(),
						true,
					).latestAnchorToolCallId;
					pi.sendMessage<WorkingMemoryNudgeDetails>(
						{
							customType: NUDGE_TYPE,
							content: manualInstruction(),
							display: true,
							details: {
								v: 1,
								kind: "manual",
								tokens: null,
								boundaryTokens: null,
								reminder: null,
								tier: null,
								tierCount: null,
								anchorToolCallId: anchor ?? null,
							},
						},
						{ deliverAs: "steer", triggerTurn: true },
					);
				},
			});
			commandRegistered = true;
		}
		syncBranch(ctx);
	});

	pi.on("before_agent_start", (event, ctx) => {
		if (!enabled) return undefined;
		const usage = ctx.getContextUsage();
		if (!usage || usage.tokens === null || !Number.isFinite(usage.tokens)) return undefined;
		const reminder = Math.floor(Math.max(0, usage.tokens) / interval);
		if (reminder < 1) return undefined;
		const instruction = instructions[Math.min(reminder, instructions.length) - 1] ?? instructions[0];
		return { systemPrompt: `${event.systemPrompt}\n\n${automaticInstruction(instruction)}` };
	});

	pi.on("turn_end", (event, ctx) => {
		if (!enabled || event.toolResults.length === 0) return undefined;
		const usage = ctx.getContextUsage();
		if (!usage || usage.tokens === null || !Number.isFinite(usage.tokens)) return undefined;
		const tokens = Math.max(0, Math.floor(usage.tokens));
		const branch = ctx.sessionManager.getBranch();
		const anchor = replayWorkingMemoryState(branch, true).latestAnchorToolCallId;
		if (anchor !== nudgeState.anchorToolCallId) nudgeState = reconstructNudgeState(branch, anchor);
		if (anchor !== undefined && nudgeState.suppressedThroughTokens === undefined) {
			const floor = Math.floor(tokens / interval) * interval;
			pi.appendEntry(BASELINE_TYPE, { v: 1, anchorToolCallId: anchor, suppressedThroughTokens: floor });
			nudgeState.suppressedThroughTokens = floor;
			nudgeState.highestBoundaryTokens = floor;
			return undefined;
		}
		const reminder = Math.floor(tokens / interval);
		if (reminder < 1) return undefined;
		const boundaryTokens = reminder * interval;
		if (boundaryTokens <= nudgeState.highestBoundaryTokens) return undefined;
		const tier = Math.min(reminder, instructions.length);
		const instruction = instructions[tier - 1] ?? instructions[0];
		pi.sendMessage<WorkingMemoryNudgeDetails>(
			{
				customType: NUDGE_TYPE,
				content: automaticInstruction(instruction),
				display: true,
				details: {
					v: 1,
					kind: "automatic",
					tokens,
					boundaryTokens,
					reminder,
					tier,
					tierCount: instructions.length,
					anchorToolCallId: anchor ?? null,
				},
			},
			{ deliverAs: "steer" },
		);
		nudgeState.highestBoundaryTokens = boundaryTokens;
		return undefined;
	});

	pi.on("context", (event, ctx) => {
		if (!enabled) return undefined;
		const branch = ctx.sessionManager.getBranch();
		const state = replayWorkingMemoryState(branch, true);
		const messages = projectWorkingMemory(event.messages, state, branch, ctx.sessionManager.buildContextEntries());
		if (!setsEqual(visualRows, state.prunedRowIds)) {
			visualRows = new Set(state.prunedRowIds);
			pushVisualSnapshot();
		}
		return { messages };
	});

	pi.on("session_tree", (_event, ctx) => {
		invalidate();
		syncBranch(ctx);
	});
	pi.on("session_compact", (_event, ctx) => {
		invalidate();
		syncBranch(ctx);
	});
	pi.on("session_shutdown", () => {
		invalidate();
		enabled = false;
		setToolActive(false);
		visualRows.clear();
		pushVisualSnapshot();
	});
}

function reconstructNudgeState(branch: readonly SessionEntry[], anchor: string | undefined): NudgeState {
	let suppressedThroughTokens = anchor === undefined ? 0 : undefined;
	let highestBoundaryTokens = 0;
	let anchorResultIndex = -1;
	if (anchor !== undefined) {
		anchorResultIndex = branch.findIndex(
			(entry) =>
				entry.type === "message" &&
				entry.message.role === "toolResult" &&
				entry.message.toolName === WORKING_MEMORY_TOOL &&
				entry.message.toolCallId === anchor,
		);
	}
	for (let index = anchorResultIndex + 1; index < branch.length; index += 1) {
		const entry = branch[index];
		if (!entry) continue;
		if (entry.type === "custom" && entry.customType === BASELINE_TYPE) {
			const baseline = parseBaseline(entry.data);
			if (baseline !== undefined && baseline.anchorToolCallId === anchor) {
				suppressedThroughTokens = baseline.suppressedThroughTokens;
				highestBoundaryTokens = Math.max(highestBoundaryTokens, baseline.suppressedThroughTokens);
			}
			continue;
		}
		if (entry.type !== "custom_message" || entry.customType !== NUDGE_TYPE) continue;
		const details = parseWorkingMemoryNudge(entry.details);
		if (details?.kind !== "automatic" || details.anchorToolCallId !== (anchor ?? null)) continue;
		highestBoundaryTokens = Math.max(highestBoundaryTokens, details.boundaryTokens);
	}
	return { anchorToolCallId: anchor, suppressedThroughTokens, highestBoundaryTokens };
}

function parseBaseline(value: unknown): { anchorToolCallId: string; suppressedThroughTokens: number } | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	if (
		record.v !== 1 ||
		typeof record.anchorToolCallId !== "string" ||
		!Number.isSafeInteger(record.suppressedThroughTokens) ||
		(record.suppressedThroughTokens as number) < 0
	) {
		return undefined;
	}
	return {
		anchorToolCallId: record.anchorToolCallId,
		suppressedThroughTokens: record.suppressedThroughTokens as number,
	};
}

function automaticInstruction(instruction: string): string {
	return `Internal working-memory instruction. Follow silently without mentioning token counts or context management. ${instruction} Use working_memory only when a selective checkpoint improves future work; never prune useful evidence merely to reread it.`;
}

function manualInstruction(): string {
	return "Internal working-memory instruction. Follow silently. Reassess active evidence, use working_memory if a selective checkpoint improves future work, then continue unfinished work. Do not mention this request.";
}

function setsEqual(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
	if (left.size !== right.size) return false;
	for (const value of left) if (!right.has(value)) return false;
	return true;
}
