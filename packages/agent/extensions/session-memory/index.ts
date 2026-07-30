import { defineTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { emitTauEvent, onTauEvent } from "../../shared/events.ts";
import { loadTauExtensionSettings } from "../../shared/settings/load.ts";
import { createToolRowStateStore } from "../../shared/tool-row-state.ts";
import { projectSessionMemory } from "./projection.ts";
import {
	renderSessionMemoryCall,
	renderSessionMemoryInstruction,
	renderSessionMemoryResult,
	type SessionMemoryInstructionDetails,
} from "./render.ts";
import sessionMemorySettings from "./settings.ts";
import {
	replaySessionMemory,
	SESSION_MEMORY_TOOL,
	sessionMemoryParameters,
	type SessionMemoryDetailsV2,
} from "./state.ts";
import { executeSessionMemory } from "./tool.ts";
import { createSessionMemoryWidget } from "./widget.ts";

const INSTRUCTION_TYPE = "tau.session-memory.instruction";
const REQUIRED_INSTRUCTION =
	"Checkpoint required. Reconcile session memory with action update before using other tools.";
const MEMORY_REMINDER =
	"Review session memory. Record expensive findings, keep only unfinished tasks, and remove stale state with session_memory action update.";
const CHECKPOINT_WARNING =
	"Checkpoint approaching. Reconcile short-term memories, unfinished tasks, and files with session_memory action update.";
const REQUIRED_RESERVE = 30_000;
const ADVISORY_THRESHOLDS = [50_000, 100_000] as const;

type Gate = { kind: "open" } | { kind: "required" } | { kind: "awaiting"; toolCallId: string };

export default function sessionMemoryExtension(pi: ExtensionAPI): void {
	let enabled = false;
	let showToolRows = sessionMemorySettings.defaults.showToolRows;
	let generation = 0;
	let contextCeilingTokens = sessionMemorySettings.defaults.contextCeilingTokens;
	let gate: Gate = { kind: "open" };
	let requiredToolCallId: string | undefined;
	let requiredInstructionQueued = false;
	let advisoryBoundaries = new Set<number>();
	let visualRows = new Set<string>();
	const rowState = createToolRowStateStore(pi, "session-memory.tool-row-state");

	const pushVisualSnapshot = () => {
		emitTauEvent(pi, "tau:tool-row-state.snapshot", {
			states: [...visualRows].map((rowId) => ({ rowId, state: "pruned" as const })),
		});
	};
	onTauEvent(
		pi,
		"session-memory.tool-row-state-producer",
		"tau:tool-row-state.snapshot.requested",
		pushVisualSnapshot,
	);

	const setToolActive = (active: boolean) => {
		const tools = pi.getActiveTools();
		const current = tools.includes(SESSION_MEMORY_TOOL);
		if (active === current) return;
		pi.setActiveTools(
			active ? [...tools, SESSION_MEMORY_TOOL] : tools.filter((name) => name !== SESSION_MEMORY_TOOL),
		);
	};
	const invalidate = () => {
		generation += 1;
	};
	const syncBranch = (ctx: ExtensionContext) => {
		const replay = replaySessionMemory(ctx.sessionManager.getBranch(), ctx.cwd);
		visualRows = new Set(replay.prunedRowIds);
		gate = { kind: "open" };
		requiredToolCallId = undefined;
		requiredInstructionQueued = false;
		advisoryBoundaries = new Set();
		pushVisualSnapshot();
	};
	const evaluateGate = (ctx: ExtensionContext): SessionMemoryInstructionDetails | undefined => {
		if (!enabled || gate.kind === "awaiting") return undefined;
		const replay = replaySessionMemory(ctx.sessionManager.getBranch(), ctx.cwd);
		if (replay.latestCheckpoint && !replay.hasPostCheckpointAssistant) return undefined;
		const usage = ctx.getContextUsage();
		if (!usage || usage.tokens === null || !Number.isFinite(usage.tokens)) return undefined;
		const tokens = Math.max(0, Math.floor(usage.tokens));
		const modelWindow = ctx.model?.contextWindow;
		const effectiveCeiling =
			typeof modelWindow === "number" && Number.isFinite(modelWindow)
				? Math.min(contextCeilingTokens, modelWindow)
				: contextCeilingTokens;
		const requiredAt = Math.max(1, effectiveCeiling - REQUIRED_RESERVE);
		if (tokens >= requiredAt) {
			if (gate.kind === "open") {
				gate = { kind: "required" };
				return { v: 1, kind: "required", boundaryTokens: requiredAt };
			}
			return undefined;
		}
		for (const [index, boundary] of ADVISORY_THRESHOLDS.entries()) {
			if (boundary >= requiredAt || tokens < boundary || advisoryBoundaries.has(boundary)) continue;
			advisoryBoundaries.add(boundary);
			return { v: 1, kind: index === 0 ? "reminder" : "warning", boundaryTokens: boundary };
		}
		return undefined;
	};
	const instructionMessage = (details: SessionMemoryInstructionDetails) => ({
		customType: INSTRUCTION_TYPE,
		content:
			details.kind === "required"
				? REQUIRED_INSTRUCTION
				: details.kind === "warning"
					? CHECKPOINT_WARNING
					: details.kind === "manual"
						? "Reconcile session memory with action update: keep only unfinished tasks, current task first, and remove completed or abandoned tasks. Then checkpoint and continue unfinished work."
						: MEMORY_REMINDER,
		display: details.kind === "manual",
		details,
	});

	pi.registerMessageRenderer<SessionMemoryInstructionDetails>(INSTRUCTION_TYPE, (message, _options, theme) =>
		renderSessionMemoryInstruction(message.details, theme),
	);

	pi.registerTool(
		defineTool<typeof sessionMemoryParameters, SessionMemoryDetailsV2>({
			name: SESSION_MEMORY_TOOL,
			label: SESSION_MEMORY_TOOL,
			renderShell: "self",
			description:
				"Replace bounded session state or checkpoint it. Every successful call returns the full authoritative state with stable memory IDs.",
			promptSnippet: "Update or checkpoint bounded session memory",
			promptGuidelines: [
				"Use session_memory action update to replace the optional long-term goal, tasks, short-term and long-term memories, and file tiers; the latest successful result is authoritative.",
				"Set longTermGoal to null unless work needs durable direction across many tasks or checkpoints that tasks alone cannot capture. Change it when that direction changes.",
				"Keep tasks as ordered unfinished work with the current task first. Remove completed or abandoned tasks immediately.",
				"Before a final response, use action update to reconcile session memory whenever task status or other saved state changed.",
				"Keep existing memory IDs when editing or moving memories between short-term and long-term. Omit an ID to forget it and use a new lowercase kebab-case ID for new memory.",
				"Use session_memory action checkpoint as the only tool call in its assistant message and only after an update in the current checkpoint span. A required checkpoint accepts action update and checkpoints it automatically.",
				"Treat file tiers as the next checkpoint restore manifest. Ordinary updates only save tiers; checkpoints load readFiles and outlineFiles.",
				"Put exact source needed after the next checkpoint in readFiles, structural context in outlineFiles, and inactive paths with a concrete reconsideration condition in deferFiles. Use one tier per path.",
			],
			parameters: sessionMemoryParameters,
			executionMode: "sequential",
			async execute(toolCallId, params, signal, _onUpdate, ctx) {
				const required = requiredToolCallId === toolCallId && gate.kind === "required";
				try {
					const execution = await executeSessionMemory({
						pi,
						toolCallId,
						params,
						signal,
						ctx,
						generation,
						currentGeneration: () => generation,
						required,
					});
					if (execution.result.details.kind === "checkpoint") {
						if (execution.readFiles.length > 0) {
							emitTauEvent(pi, "tau:autoread.requested", {
								source: SESSION_MEMORY_TOOL,
								title: "Session-memory checkpoint",
								cwd: ctx.cwd,
								batchId: `${toolCallId}:read`,
								files: execution.readFiles.map((path) => ({ path })),
							});
						}
						for (const outline of execution.outlines) pi.sendMessage(outline, { deliverAs: "steer" });
						gate = { kind: "awaiting", toolCallId };
					}
					return execution.result;
				} finally {
					if (requiredToolCallId === toolCallId && gate.kind !== "awaiting") requiredToolCallId = undefined;
				}
			},
			renderCall(args, theme, context) {
				return renderSessionMemoryCall(args, theme, {
					visible: showToolRows,
					rowState,
					rowId: context.toolCallId,
					invalidate: context.invalidate,
					lastComponent: context.lastComponent,
				});
			},
			renderResult(result, _options, theme, context) {
				return renderSessionMemoryResult(result, showToolRows, theme, context.lastComponent);
			},
		}),
	);

	pi.registerCommand("prune", {
		description: "Ask agent to update and checkpoint session memory",
		async handler(args, ctx) {
			if (!enabled) {
				ctx.ui.notify("Session memory is disabled.", "info");
				return;
			}
			if (args.trim()) {
				ctx.ui.notify("Usage: /prune", "info");
				return;
			}
			pi.sendMessage(instructionMessage({ v: 1, kind: "manual", boundaryTokens: null }), {
				deliverAs: "steer",
				triggerTurn: true,
			});
		},
	});

	pi.registerCommand("session-memory", {
		description: "Show session-memory panel",
		async handler(args, ctx) {
			if (!enabled) {
				ctx.ui.notify("Session memory is disabled.", "info");
				return;
			}
			if (args.trim()) {
				ctx.ui.notify("Usage: /session-memory", "info");
				return;
			}
			if (ctx.mode !== "tui" || !ctx.hasUI) {
				ctx.ui.notify("Session memory panel requires TUI mode.", "error");
				return;
			}
			const replay = replaySessionMemory(ctx.sessionManager.getBranch(), ctx.cwd);
			const latest = replay.latest;
			const usage = ctx.getContextUsage();
			const activeTokens =
				usage && usage.tokens !== null && Number.isFinite(usage.tokens) ? Math.max(0, Math.floor(usage.tokens)) : 0;
			const state = latest?.state;
			await ctx.ui.custom<void>((tui, theme, keys, done) =>
				createSessionMemoryWidget(tui, theme, keys, {
					view: state
						? {
								longTermGoal: state.longTermGoal,
								checkpoint: latest.checkpoint,
								activeTokens,
								updatedAt: replay.updatedAt,
								tasks: state.tasks,
								shortTermMemories: state.shortTermMemories,
								longTermMemories: state.longTermMemories,
								readFiles: state.readFiles,
								outlineFiles: state.outlineFiles,
								deferFiles: state.deferFiles,
							}
						: {
								longTermGoal: null,
								checkpoint: 0,
								activeTokens,
								updatedAt: undefined,
								tasks: [],
								shortTermMemories: [],
								longTermMemories: [],
								readFiles: [],
								outlineFiles: [],
								deferFiles: [],
							},
					selectedTab: "tasks",
					onClose: () => done(undefined),
				}),
			);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		invalidate();
		enabled = false;
		showToolRows = sessionMemorySettings.defaults.showToolRows;
		setToolActive(false);
		const current = generation;
		const settings = await loadTauExtensionSettings(ctx, sessionMemorySettings);
		if (current !== generation) return;
		enabled = settings.enabled;
		showToolRows = settings.showToolRows;
		contextCeilingTokens = settings.contextCeilingTokens;
		setToolActive(enabled);
		syncBranch(ctx);
	});

	pi.on("before_agent_start", (_event, ctx) => {
		const instruction = evaluateGate(ctx);
		return instruction ? { message: instructionMessage(instruction) } : undefined;
	});

	pi.on("tool_call", (event, ctx) => {
		const instruction = evaluateGate(ctx);
		if (
			instruction?.kind === "required" &&
			!(event.toolName === SESSION_MEMORY_TOOL && isUpdateAction(event.input))
		) {
			pi.sendMessage(instructionMessage(instruction), { deliverAs: "steer" });
			requiredInstructionQueued = true;
		}
		if (gate.kind === "open") return undefined;
		if (gate.kind === "awaiting") {
			return { block: true, reason: "Checkpoint projection is pending." };
		}
		if (event.toolName !== SESSION_MEMORY_TOOL) {
			return { block: true, reason: "Checkpoint required. Update session memory first." };
		}
		if (!isUpdateAction(event.input)) {
			return { block: true, reason: "Checkpoint required. Use session_memory with action update." };
		}
		if (requiredToolCallId && requiredToolCallId !== event.toolCallId) {
			return { block: true, reason: "A required session-memory update is already pending." };
		}
		requiredToolCallId = event.toolCallId;
		return undefined;
	});

	pi.on("turn_end", (_event, ctx) => {
		if (gate.kind === "required") {
			if (requiredInstructionQueued) requiredInstructionQueued = false;
			else
				pi.sendMessage(instructionMessage({ v: 1, kind: "required", boundaryTokens: null }), {
					deliverAs: "steer",
				});
			return;
		}
		const instruction = evaluateGate(ctx);
		if (instruction) pi.sendMessage(instructionMessage(instruction), { deliverAs: "steer" });
	});

	pi.on("context", (event, ctx) => {
		if (!enabled) return undefined;
		const replay = replaySessionMemory(ctx.sessionManager.getBranch(), ctx.cwd);
		const projection = projectSessionMemory(event.messages, replay);
		if (gate.kind === "awaiting" && projection.projectedCheckpointId === gate.toolCallId) {
			gate = { kind: "open" };
			requiredToolCallId = undefined;
			advisoryBoundaries = new Set();
		}
		if (!setsEqual(visualRows, replay.prunedRowIds)) {
			visualRows = new Set(replay.prunedRowIds);
			pushVisualSnapshot();
		}
		return { messages: projection.messages };
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
		showToolRows = sessionMemorySettings.defaults.showToolRows;
		setToolActive(false);
		gate = { kind: "open" };
		requiredToolCallId = undefined;
		visualRows.clear();
		pushVisualSnapshot();
	});
}

function isUpdateAction(value: unknown): boolean {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		(value as { action?: unknown }).action === "update"
	);
}

function setsEqual(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
	if (left.size !== right.size) return false;
	for (const item of left) if (!right.has(item)) return false;
	return true;
}
