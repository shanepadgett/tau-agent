import {
	defineTool,
	type ContextEvent,
	type ExtensionAPI,
	type ExtensionContext,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
	replayContextPruningState,
	setContextPruningEnabled,
	type ContextPruneDetailsV1,
} from "../../shared/context-pruning-state.ts";
import { emitTauEvent, onTauEvent } from "../../shared/events.ts";
import { loadTauExtensionSettings } from "../../shared/settings/load.ts";
import { createToolRowStateStore } from "../../shared/tool-row-state.ts";
import { contextPruneParameters, executeContextPrune } from "./prune.ts";
import { projectContext } from "./projection.ts";
import {
	parseContextPruningNudgeDetailsV1,
	renderContextPruneCall,
	renderContextPruneResult,
	renderContextPruningNudge,
	type ContextPruningNudgeDetailsV1,
} from "./render.ts";
import contextPruningSettings from "./settings.ts";

interface ProjectionCache {
	generation: number;
	input: ContextEvent["messages"];
	stateKey: string;
	messages: ContextEvent["messages"];
}

const TOOL_DESCRIPTION =
	"Create a context anchor after broad exploration converges, after a context-pressure nudge, or when substantial irrelevant tool evidence has accumulated. Do not use after routine tool batches or when expected savings are small. Immediately before calling, state retained conclusions, conditional relevance, and the next action in visible prose. Call context_prune alone in its tool batch.";
const NUDGE_MESSAGE_TYPE = "tau.context-pruning.nudge";
const NUDGE_BASELINE_ENTRY_TYPE = "tau.context-pruning.nudge-baseline";

interface NudgeState {
	anchorToolCallId: string | undefined;
	growthBaselinePercent: number | undefined;
	highestBoundary: number;
}

export default function contextPruningExtension(pi: ExtensionAPI): void {
	let enabled = false;
	let lifecycleGeneration = 0;
	let projectionCache: ProjectionCache | undefined;
	let minimumReclaimTokens = contextPruningSettings.defaults.minimumReclaimTokens;
	let nudgeEveryPercent = contextPruningSettings.defaults.nudgeEveryPercent;
	let pressurePercent = contextPruningSettings.defaults.pressurePercent;
	let toolRegistered = false;
	let commandRegistered = false;
	let visualRows = new Set<string>();
	let nudgeState: NudgeState = {
		anchorToolCallId: undefined,
		growthBaselinePercent: 0,
		highestBoundary: 0,
	};
	const rowState = createToolRowStateStore(pi, "context-pruning.tool-row-state");
	pi.registerMessageRenderer<ContextPruningNudgeDetailsV1>(NUDGE_MESSAGE_TYPE, (message, _options, theme) =>
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
		projectionCache = undefined;
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
		minimumReclaimTokens = settings.minimumReclaimTokens;
		nudgeEveryPercent = settings.nudgeEveryPercent;
		pressurePercent = settings.pressurePercent;
		setContextPruningEnabled(enabled);
		if (enabled && !toolRegistered) {
			pi.registerTool(
				defineTool<typeof contextPruneParameters, ContextPruneDetailsV1>({
					name: "context_prune",
					label: "context_prune",
					description: TOOL_DESCRIPTION,
					promptSnippet:
						"Prune substantial stale tool evidence after stating durable conclusions and the next action",
					promptGuidelines: [
						"Use context_prune after broad exploration converges, after a context-pressure nudge, or when substantial irrelevant evidence has accumulated.",
						"Do not use context_prune after routine tool batches or when expected savings are small.",
						"Immediately before context_prune, write visible prose with retained conclusions, conditional relevance, and the next action, then call context_prune alone in its tool batch.",
					],
					parameters: contextPruneParameters,
					executionMode: "sequential",
					async execute(toolCallId, params, signal, _onUpdate, executionContext) {
						const cache = projectionCache;
						return executeContextPrune({
							pi,
							toolCallId,
							params,
							signal,
							ctx: executionContext,
							projection: cache && { generation: cache.generation, messages: cache.messages },
							currentGeneration: () => lifecycleGeneration,
							currentEnabled: () => enabled,
							minimumReclaimTokens,
						});
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
					pi.sendMessage<ContextPruningNudgeDetailsV1>(
						{
							customType: NUDGE_MESSAGE_TYPE,
							content: manualPruneSteeringMessage(),
							display: true,
							details: {
								v: 1,
								kind: "manual",
								percent: null,
								boundary: null,
								pressure: false,
								anchorToolCallId: anchorToolCallId ?? null,
								growthBaselinePercent: null,
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
		nudgeState = { anchorToolCallId: undefined, growthBaselinePercent: 0, highestBoundary: 0 };
		setContextPruningEnabled(false);
		pushVisualSnapshot();
	});

	pi.on("turn_end", (event, ctx) => {
		if (!enabled || event.toolResults.length === 0) return undefined;
		const usage = ctx.getContextUsage();
		if (!usage || usage.percent === null || !Number.isFinite(usage.percent)) return undefined;
		const rawPercent = Math.max(0, Math.min(100, usage.percent));
		const percent = Math.floor(rawPercent);
		const activeAnchor = replayContextPruningState(ctx.sessionManager.getBranch(), true).latestAnchorToolCallId;
		if (activeAnchor !== nudgeState.anchorToolCallId) {
			nudgeState = reconstructNudgeState(ctx.sessionManager.getBranch(), activeAnchor);
		}
		if (activeAnchor !== undefined && nudgeState.growthBaselinePercent === undefined) {
			const baselinePercent = Math.ceil(rawPercent);
			pi.appendEntry(NUDGE_BASELINE_ENTRY_TYPE, {
				v: 1,
				anchorToolCallId: activeAnchor,
				baselinePercent,
			});
			nudgeState.growthBaselinePercent = baselinePercent;
			return undefined;
		}
		const baseline = nudgeState.growthBaselinePercent ?? 0;
		if (percent - baseline < nudgeEveryPercent) return undefined;
		const boundary = Math.floor(percent / nudgeEveryPercent) * nudgeEveryPercent;
		if (boundary <= nudgeState.highestBoundary) return undefined;
		const pressure = rawPercent > pressurePercent;
		const details: ContextPruningNudgeDetailsV1 = {
			v: 1,
			kind: "automatic",
			percent,
			boundary,
			pressure,
			anchorToolCallId: activeAnchor ?? null,
			growthBaselinePercent: baseline,
		};
		pi.sendMessage<ContextPruningNudgeDetailsV1>(
			{
				customType: NUDGE_MESSAGE_TYPE,
				content: automaticPruneSteeringMessage(pressure),
				display: true,
				details,
			},
			{ deliverAs: "steer" },
		);
		nudgeState.highestBoundary = boundary;
		return undefined;
	});

	pi.on("context", (event, ctx) => {
		if (!enabled) return undefined;
		const state = replayContextPruningState(ctx.sessionManager.getBranch(), true);
		const stateKey = JSON.stringify([
			state.latestAnchorToolCallId,
			[...state.prunedToolCallIds],
			[...state.prunedAutoreadRowIds],
		]);
		if (
			projectionCache?.generation === lifecycleGeneration &&
			projectionCache.input === event.messages &&
			projectionCache.stateKey === stateKey
		) {
			return { messages: projectionCache.messages };
		}

		try {
			const messages = projectContext(event.messages, state);
			projectionCache = { generation: lifecycleGeneration, input: event.messages, stateKey, messages };
			const nextRows = new Set([...state.prunedToolCallIds, ...state.prunedAutoreadRowIds]);
			if (!setsEqual(visualRows, nextRows)) {
				visualRows = nextRows;
				pushVisualSnapshot();
			}
			return { messages };
		} catch {
			projectionCache = undefined;
			return undefined;
		}
	});
}

function setsEqual(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
	if (left.size !== right.size) return false;
	for (const item of left) if (!right.has(item)) return false;
	return true;
}

function reconstructNudgeState(branch: readonly SessionEntry[], anchorToolCallId: string | undefined): NudgeState {
	let growthBaselinePercent = anchorToolCallId === undefined ? 0 : undefined;
	let highestBoundary = 0;
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
				growthBaselinePercent === undefined &&
				index > anchorResultIndex &&
				baseline.anchorToolCallId === anchorToolCallId
			) {
				growthBaselinePercent = baseline.baselinePercent;
			}
			continue;
		}
		if (entry.type !== "custom_message" || entry.customType !== NUDGE_MESSAGE_TYPE) continue;
		const details = parseContextPruningNudgeDetailsV1(entry.details);
		if (
			!details ||
			details.kind !== "automatic" ||
			details.anchorToolCallId !== (anchorToolCallId ?? null) ||
			details.boundary === null ||
			details.growthBaselinePercent === null
		)
			continue;
		highestBoundary = Math.max(highestBoundary, details.boundary);
		growthBaselinePercent = details.growthBaselinePercent;
	}
	return { anchorToolCallId, growthBaselinePercent, highestBoundary };
}

function parseNudgeBaseline(value: unknown): { v: 1; anchorToolCallId: string; baselinePercent: number } | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	if (
		Object.keys(record).length !== 3 ||
		!Object.hasOwn(record, "v") ||
		!Object.hasOwn(record, "anchorToolCallId") ||
		!Object.hasOwn(record, "baselinePercent") ||
		record.v !== 1 ||
		typeof record.anchorToolCallId !== "string" ||
		record.anchorToolCallId.length === 0 ||
		typeof record.baselinePercent !== "number" ||
		!Number.isInteger(record.baselinePercent) ||
		record.baselinePercent < 0 ||
		record.baselinePercent > 100
	)
		return undefined;
	return {
		v: 1,
		anchorToolCallId: record.anchorToolCallId,
		baselinePercent: record.baselinePercent,
	};
}

function automaticPruneSteeringMessage(pressure: boolean): string {
	const silent =
		"Internal context-management instruction. Follow it silently. Do not mention or acknowledge context percentages, prune messages, or internal context management.";
	if (pressure) {
		return `${silent} Finish the current coherent step. When projected savings are substantial, preserve durable conclusions and the next action in visible prose, then call context_prune alone. Do not prune after a routine tool batch or retry immediately after a skipped prune.`;
	}
	return `${silent} No prune is required unless broad exploration has converged or substantial evidence is already irrelevant. Continue coherent work. If pruning becomes worthwhile, preserve durable conclusions and the next action in visible prose, then call context_prune alone.`;
}

function manualPruneSteeringMessage(): string {
	return "Internal context-management instruction. Follow it silently without mentioning this request. Create a context anchor with context_prune, then continue unfinished work. First preserve durable conclusions, conditional relevance, and the next action in visible prose. Call context_prune alone. If projected savings are too small, continue work without immediately retrying.";
}
