import {
	defineTool,
	type ExtensionAPI,
	type ExtensionContext,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { registerAutoread } from "../../shared/autoread.ts";
import {
	replayContextPruningState,
	setContextPruningEnabled,
	type ContextPruneDetailsV2,
} from "../../shared/context-pruning-state.ts";
import { emitTauEvent, onTauEvent } from "../../shared/events.ts";
import { loadTauExtensionSettings } from "../../shared/settings/load.ts";
import { createToolRowStateStore } from "../../shared/tool-row-state.ts";
import { contextPruneParameters, executeContextPrune } from "./prune.ts";
import { projectContext } from "./projection.ts";
import {
	parseContextPruningNudgeDetailsV3,
	renderContextPruneCall,
	renderContextPruneResult,
	renderContextPruningNudge,
	type ContextPruningNudgeDetailsV3,
} from "./render.ts";
import contextPruningSettings from "./settings.ts";

const TOOL_DESCRIPTION =
	"Create a hard context checkpoint after broad exploration converges, when a context-pruning nudge directs it, or when stale evidence has accumulated. Everything before the checkpoint is removed from future model context unless selected for retention. Immediately before calling, state durable conclusions, conditional relevance, and the next action in visible prose.";
const NUDGE_MESSAGE_TYPE = "tau.context-pruning.nudge";
const NUDGE_BASELINE_ENTRY_TYPE = "tau.context-pruning.nudge-baseline";

interface NudgeState {
	anchorToolCallId: string | undefined;
	suppressedThroughTokens: number | undefined;
	highestBoundaryTokens: number;
	highestTier: number;
	terminalTierReached: boolean;
}

export default function contextPruningExtension(pi: ExtensionAPI): void {
	let enabled = false;
	let lifecycleGeneration = 0;
	let nudgeEveryTokens = contextPruningSettings.defaults.nudgeEveryTokens;
	let nudgeInstructions = contextPruningSettings.defaults.nudgeInstructions;
	let toolRegistered = false;
	let commandRegistered = false;
	let visualRows = new Set<string>();
	let nudgeState: NudgeState = {
		anchorToolCallId: undefined,
		suppressedThroughTokens: 0,
		highestBoundaryTokens: 0,
		highestTier: 0,
		terminalTierReached: false,
	};
	const rowState = createToolRowStateStore(pi, "context-pruning.tool-row-state");
	registerAutoread(pi, rowState);
	pi.registerMessageRenderer<ContextPruningNudgeDetailsV3>(NUDGE_MESSAGE_TYPE, (message, _options, theme) =>
		renderContextPruningNudge(message.details, theme),
	);

	const pushVisualSnapshot = () => {
		emitTauEvent(pi, "tau:tool-row-state.snapshot", {
			states: [...visualRows].map((rowId) => ({ rowId, state: "pruned" as const })),
		});
	};
	onTauEvent(
		pi,
		"context-pruning.tool-row-state-producer",
		"tau:tool-row-state.snapshot.requested",
		pushVisualSnapshot,
	);

	const clearEphemeralState = () => {
		lifecycleGeneration += 1;
	};
	const setContextPruneToolActive = (active: boolean) => {
		if (!toolRegistered) return;
		const activeTools = pi.getActiveTools();
		const currentlyActive = activeTools.includes("context_prune");
		if (active === currentlyActive) return;
		pi.setActiveTools(
			active ? [...activeTools, "context_prune"] : activeTools.filter((toolName) => toolName !== "context_prune"),
		);
	};
	const syncBranchState = (ctx: ExtensionContext) => {
		const state = replayContextPruningState(ctx.sessionManager.getBranch(), enabled);
		visualRows = new Set([...state.prunedToolCallIds, ...state.prunedAutoreadRowIds]);
		nudgeState = reconstructNudgeState(ctx.sessionManager.getBranch(), state.latestAnchorToolCallId);
		pushVisualSnapshot();
	};

	pi.on("session_start", async (_event, ctx) => {
		clearEphemeralState();
		enabled = false;
		setContextPruneToolActive(false);
		visualRows.clear();
		setContextPruningEnabled(false);
		pushVisualSnapshot();
		const generation = lifecycleGeneration;
		const settings = await loadTauExtensionSettings(ctx, contextPruningSettings);
		if (generation !== lifecycleGeneration) return;
		enabled = settings.enabled;
		nudgeEveryTokens = settings.nudgeEveryTokens;
		nudgeInstructions = settings.nudgeInstructions;
		setContextPruningEnabled(enabled);
		if (enabled && !toolRegistered) {
			pi.registerTool(
				defineTool<typeof contextPruneParameters, ContextPruneDetailsV2>({
					name: "context_prune",
					label: "context_prune",
					description: TOOL_DESCRIPTION,
					promptSnippet:
						"Prune substantial stale tool evidence after stating durable conclusions and the next action",
					promptGuidelines: [
						"Use context_prune after broad exploration converges, when a context-pruning nudge directs it, or when substantial irrelevant evidence has accumulated.",
						"A final-tier context-pruning nudge means preserve durable conclusions and prune before further tool work.",
						"Everything before context_prune leaves future model context unless selected in keepFiles or keepToolCalls, so preserve durable conclusions, user constraints, conditional relevance, and the next action in visible prose immediately before calling it.",
					],
					parameters: contextPruneParameters,
					executionMode: "sequential",
					async execute(toolCallId, params, signal, _onUpdate, executionContext) {
						const execution = await executeContextPrune({
							toolCallId,
							params,
							signal,
							ctx: executionContext,
							generation: lifecycleGeneration,
							currentGeneration: () => lifecycleGeneration,
						});
						for (const autoread of execution.autoreads) {
							pi.sendMessage(autoread, { deliverAs: "steer" });
						}
						return execution.result;
					},
					renderCall(args, theme, context) {
						return renderContextPruneCall(args, theme, {
							rowState,
							rowId: context.toolCallId,
							invalidate: context.invalidate,
							lastComponent: context.lastComponent,
						});
					},
					renderResult(result, options, theme, context) {
						return renderContextPruneResult(result, options.expanded, theme, context.lastComponent);
					},
				}),
			);
			toolRegistered = true;
		}
		setContextPruneToolActive(enabled);
		if (enabled && !commandRegistered) {
			pi.registerCommand("prune", {
				description: "Ask the agent to create a context-pruning anchor and continue its task",
				async handler(args, commandContext) {
					if (!enabled) {
						commandContext.ui.notify("Context pruning is disabled.", "info");
						return;
					}
					if (args.trim().length > 0) {
						commandContext.ui.notify("Usage: /prune", "info");
						return;
					}
					const anchorToolCallId = replayContextPruningState(
						commandContext.sessionManager.getBranch(),
						true,
					).latestAnchorToolCallId;
					pi.sendMessage<ContextPruningNudgeDetailsV3>(
						{
							customType: NUDGE_MESSAGE_TYPE,
							content: manualPruneSteeringMessage(),
							display: true,
							details: {
								v: 3,
								kind: "manual",
								tokens: null,
								boundaryTokens: null,
								reminder: null,
								tier: null,
								tierCount: null,
								tierFloor: null,
								anchorToolCallId: anchorToolCallId ?? null,
								suppressedThroughTokens: null,
							},
						},
						{ deliverAs: "steer", triggerTurn: true },
					);
				},
			});
			commandRegistered = true;
		}
		syncBranchState(ctx);
	});

	pi.on("session_tree", (_event, ctx) => {
		clearEphemeralState();
		syncBranchState(ctx);
	});
	pi.on("session_compact", (_event, ctx) => {
		clearEphemeralState();
		syncBranchState(ctx);
	});
	pi.on("session_shutdown", () => {
		clearEphemeralState();
		enabled = false;
		setContextPruneToolActive(false);
		visualRows.clear();
		nudgeState = {
			anchorToolCallId: undefined,
			suppressedThroughTokens: 0,
			highestBoundaryTokens: 0,
			highestTier: 0,
			terminalTierReached: false,
		};
		setContextPruningEnabled(false);
		pushVisualSnapshot();
	});

	pi.on("turn_end", (event, ctx) => {
		if (!enabled || event.toolResults.length === 0) return undefined;
		const usage = ctx.getContextUsage();
		if (!usage || usage.tokens === null || !Number.isFinite(usage.tokens)) return undefined;
		const tokens = Math.max(0, Math.floor(usage.tokens));
		const activeAnchor = replayContextPruningState(ctx.sessionManager.getBranch(), true).latestAnchorToolCallId;
		if (activeAnchor !== nudgeState.anchorToolCallId) {
			nudgeState = reconstructNudgeState(ctx.sessionManager.getBranch(), activeAnchor);
		}
		if (activeAnchor !== undefined && nudgeState.suppressedThroughTokens === undefined) {
			const suppressedThroughTokens = Math.floor(tokens / nudgeEveryTokens) * nudgeEveryTokens;
			pi.appendEntry(NUDGE_BASELINE_ENTRY_TYPE, {
				v: 2,
				anchorToolCallId: activeAnchor,
				suppressedThroughTokens,
			});
			nudgeState.suppressedThroughTokens = suppressedThroughTokens;
			nudgeState.highestBoundaryTokens = suppressedThroughTokens;
			return undefined;
		}
		const reminder = Math.floor(tokens / nudgeEveryTokens);
		if (reminder < 1) return undefined;
		const boundaryTokens = reminder * nudgeEveryTokens;
		if (boundaryTokens <= nudgeState.highestBoundaryTokens) return undefined;
		const tierCount = nudgeInstructions.length;
		const tierFloor = nudgeState.terminalTierReached ? tierCount : Math.min(nudgeState.highestTier, tierCount);
		const tier = Math.max(Math.min(reminder, tierCount), tierFloor);
		const instruction = nudgeInstructions[tier - 1] ?? nudgeInstructions[0];
		const details: ContextPruningNudgeDetailsV3 = {
			v: 3,
			kind: "automatic",
			tokens,
			boundaryTokens,
			reminder,
			tier,
			tierCount,
			tierFloor,
			anchorToolCallId: activeAnchor ?? null,
			suppressedThroughTokens: nudgeState.suppressedThroughTokens ?? 0,
		};
		pi.sendMessage<ContextPruningNudgeDetailsV3>(
			{
				customType: NUDGE_MESSAGE_TYPE,
				content: automaticPruneSteeringMessage(instruction, tier === tierCount),
				display: true,
				details,
			},
			{ deliverAs: "steer" },
		);
		nudgeState.highestBoundaryTokens = boundaryTokens;
		nudgeState.highestTier = Math.max(nudgeState.highestTier, tier);
		nudgeState.terminalTierReached ||= tier === tierCount;
		return undefined;
	});

	pi.on("context", (event, ctx) => {
		if (!enabled) return undefined;
		const state = replayContextPruningState(ctx.sessionManager.getBranch(), true);
		const messages = projectContext(event.messages, state);
		const nextRows = new Set([...state.prunedToolCallIds, ...state.prunedAutoreadRowIds]);
		if (!setsEqual(visualRows, nextRows)) {
			visualRows = nextRows;
			pushVisualSnapshot();
		}
		return { messages };
	});
}

function setsEqual(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
	if (left.size !== right.size) return false;
	for (const item of left) if (!right.has(item)) return false;
	return true;
}

function reconstructNudgeState(branch: readonly SessionEntry[], anchorToolCallId: string | undefined): NudgeState {
	let suppressedThroughTokens = anchorToolCallId === undefined ? 0 : undefined;
	let highestBoundaryTokens = 0;
	let highestTier = 0;
	let terminalTierReached = false;
	let anchorResultIndex = -1;
	if (anchorToolCallId !== undefined) {
		anchorResultIndex = branch.findIndex(
			(entry) =>
				entry.type === "message" &&
				entry.message.role === "toolResult" &&
				entry.message.toolName === "context_prune" &&
				entry.message.toolCallId === anchorToolCallId,
		);
	}
	for (let index = 0; index < branch.length; index += 1) {
		const entry = branch[index];
		if (!entry) continue;
		if (entry.type === "custom" && entry.customType === NUDGE_BASELINE_ENTRY_TYPE) {
			const baseline = parseNudgeBaseline(entry.data);
			if (
				baseline &&
				suppressedThroughTokens === undefined &&
				index > anchorResultIndex &&
				baseline.anchorToolCallId === anchorToolCallId
			) {
				suppressedThroughTokens = baseline.suppressedThroughTokens;
				highestBoundaryTokens = baseline.suppressedThroughTokens;
			}
			continue;
		}
		if (entry.type !== "custom_message" || entry.customType !== NUDGE_MESSAGE_TYPE) continue;
		const details = parseContextPruningNudgeDetailsV3(entry.details);
		if (
			!details ||
			details.kind !== "automatic" ||
			index <= anchorResultIndex ||
			details.anchorToolCallId !== (anchorToolCallId ?? null) ||
			details.boundaryTokens === null ||
			details.suppressedThroughTokens === null ||
			(suppressedThroughTokens !== undefined && details.suppressedThroughTokens !== suppressedThroughTokens)
		)
			continue;
		const expectedTierFloor: number = terminalTierReached
			? details.tierCount
			: Math.min(highestTier, details.tierCount);
		if (details.boundaryTokens <= highestBoundaryTokens || details.tierFloor !== expectedTierFloor) continue;
		highestBoundaryTokens = Math.max(highestBoundaryTokens, details.boundaryTokens);
		highestTier = Math.max(highestTier, details.tier);
		terminalTierReached ||= details.tier === details.tierCount;
		suppressedThroughTokens = details.suppressedThroughTokens;
	}
	return { anchorToolCallId, suppressedThroughTokens, highestBoundaryTokens, highestTier, terminalTierReached };
}

function parseNudgeBaseline(
	value: unknown,
): { v: 2; anchorToolCallId: string; suppressedThroughTokens: number } | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	if (
		Object.keys(record).length !== 3 ||
		!Object.hasOwn(record, "v") ||
		!Object.hasOwn(record, "anchorToolCallId") ||
		!Object.hasOwn(record, "suppressedThroughTokens") ||
		record.v !== 2 ||
		typeof record.anchorToolCallId !== "string" ||
		record.anchorToolCallId.length === 0 ||
		typeof record.suppressedThroughTokens !== "number" ||
		!Number.isSafeInteger(record.suppressedThroughTokens) ||
		record.suppressedThroughTokens < 0
	)
		return undefined;
	return {
		v: 2,
		anchorToolCallId: record.anchorToolCallId,
		suppressedThroughTokens: record.suppressedThroughTokens,
	};
}

function automaticPruneSteeringMessage(instruction: string, finalTier: boolean): string {
	const silent =
		"Internal context-management instruction. Follow it silently. Do not mention or acknowledge context-token counts, prune messages, or internal context management.";
	const protocol =
		"When pruning, first preserve durable conclusions, user constraints, conditional relevance, and the next action in visible prose, then call context_prune.";
	return finalTier
		? `${silent} ${instruction} This is the final reminder tier. Create a context anchor before further tool work. ${protocol}`
		: `${silent} ${instruction} ${protocol}`;
}

function manualPruneSteeringMessage(): string {
	return "Internal context-management instruction. Follow it silently without mentioning this request. Create a hard context checkpoint with context_prune, then continue unfinished work. First preserve durable conclusions, user constraints, conditional relevance, and the next action in visible prose.";
}
