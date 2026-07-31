import { resolve } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { prepareFileInjection, type PreparedFileInjection } from "@shanepadgett/tau-agent";
import { collectPrunedRowIds, findToolCallEntry } from "./projection.ts";
import {
	assertSnapshotBound,
	checkpointState,
	formatSessionMemory,
	normalizeUpdate,
	replaySessionMemory,
	SESSION_MEMORY_TOOL,
	type SessionMemoryDetailsV2,
	type SessionMemoryInput,
	type SessionMemoryState,
} from "./state.ts";

interface ExecuteSessionMemoryOptions {
	toolCallId: string;
	params: SessionMemoryInput;
	signal: AbortSignal | undefined;
	ctx: ExtensionContext;
	generation: number;
	currentGeneration(): number;
	required: boolean;
}

export interface SessionMemoryExecution {
	result: {
		content: Array<{ type: "text"; text: string }>;
		details: SessionMemoryDetailsV2;
	};
	outlines: PreparedFileInjection[];
	readFiles: string[];
}

export async function executeSessionMemory(options: ExecuteSessionMemoryOptions): Promise<SessionMemoryExecution> {
	assertCurrent(options);
	const branch = options.ctx.sessionManager.getBranch();
	const replay = replaySessionMemory(branch, options.ctx.cwd);
	if (options.required && options.params.action !== "update") {
		throw new Error("Checkpoint required. Use session_memory with action update.");
	}
	if (options.params.action === "checkpoint" && (!replay.latest || !replay.updateSinceCheckpoint)) {
		throw new Error("session_memory checkpoint requires a successful update in the current checkpoint span");
	}
	if (options.params.action === "checkpoint") {
		const anchorIndex = findToolCallEntry(branch, options.toolCallId);
		const anchor = branch[anchorIndex];
		if (
			anchor?.type !== "message" ||
			anchor.message.role !== "assistant" ||
			anchor.message.content.filter((item) => item.type === "toolCall").length !== 1
		) {
			throw new Error("session_memory checkpoint must be the only tool call in its assistant message");
		}
	}

	let state: SessionMemoryState;
	let warnings: string[] = [];
	const checkpointing = options.required || options.params.action === "checkpoint";
	const nextCheckpoint = (replay.latest?.checkpoint ?? 0) + (checkpointing ? 1 : 0);
	if (options.params.action === "update") {
		state = normalizeUpdate(
			options.params,
			replay.latest?.state,
			options.required ? nextCheckpoint : (replay.latest?.checkpoint ?? 0),
			options.ctx.cwd,
		);
	} else {
		if (!replay.latest) throw new Error("session_memory requires an update before checkpoint");
		state = replay.latest.state;
	}
	if (checkpointing) {
		const aged = checkpointState(state, replay.latest?.checkpoint ?? 0);
		state = aged.state;
		warnings.push(...aged.warnings);
	}
	assertSnapshotBound(state, nextCheckpoint);

	const rootInstructions = resolve(options.ctx.cwd, "AGENTS.md");
	if (
		options.params.action === "update" &&
		[
			...options.params.readFiles,
			...options.params.outlineFiles,
			...options.params.deferFiles.map((item) => item.path),
		].some((path) => resolve(options.ctx.cwd, path.trim().replace(/^@/, "")) === rootInstructions)
	) {
		warnings.push("AGENTS.md: omitted because root instructions are already in context");
	}

	const previousOutlineRows = new Map(
		replay.latest?.outlinedRows.map((item) => [resolve(options.ctx.cwd, item.path), item] as const) ?? [],
	);
	const readFiles = checkpointing ? state.readFiles : [];
	const outlines = checkpointing
		? await prepareFileInjection({
				cwd: options.ctx.cwd,
				source: SESSION_MEMORY_TOOL,
				batchId: `${options.toolCallId}:outline`,
				files: state.outlineFiles.map((path) => ({ path, mode: "outline" as const })),
				signal: options.signal,
			})
		: [];
	warnings.push(
		...outlines
			.filter((message) => message.details.status === "failed")
			.map((message) => boundedWarning(`${message.details.path}: ${message.details.error ?? "injection failed"}`)),
	);
	assertCurrent(options);

	const newOutlineRows = new Map(
		outlines
			.filter((message) => message.details.status === "injected")
			.map(
				(message) =>
					[
						resolve(options.ctx.cwd, message.details.path),
						{ path: message.details.path, rowId: message.details.rowId },
					] as const,
			),
	);
	const outlinedRows = state.outlineFiles.flatMap((path) => {
		const key = resolve(options.ctx.cwd, path);
		const row = checkpointing ? newOutlineRows.get(key) : previousOutlineRows.get(key);
		return row ? [row] : [];
	});
	let prunedRowIds = [...replay.prunedRowIds];
	if (checkpointing) {
		const anchorIndex = findToolCallEntry(branch, options.toolCallId);
		prunedRowIds = [...new Set([...prunedRowIds, ...collectPrunedRowIds(branch, anchorIndex)])];
	}
	warnings = [...new Set(warnings.map(boundedWarning))].slice(0, 32);
	const changes = [
		...(checkpointing ? [`Checkpoint ${nextCheckpoint} created`] : []),
		...(options.params.action === "update" ? summarizeUpdate(replay.latest?.state, state) : []),
	];
	const details: SessionMemoryDetailsV2 = {
		v: 2,
		toolCallId: options.toolCallId,
		kind: checkpointing ? "checkpoint" : "update",
		checkpoint: nextCheckpoint,
		state,
		changes: changes.length > 0 ? changes : ["No changes"],
		outlinedRows,
		prunedRowIds,
		warnings,
	};
	return {
		result: { content: [{ type: "text", text: formatSessionMemory(state, nextCheckpoint, warnings) }], details },
		outlines,
		readFiles,
	};
}

function summarizeUpdate(previous: SessionMemoryState | undefined, next: SessionMemoryState): string[] {
	if (!previous) return ["Session memory created"];
	const changes: string[] = [];
	if (previous.longTermGoal !== next.longTermGoal) changes.push("Long-term goal updated");
	addCount(changes, differenceCount(next.tasks, previous.tasks), "new task", "new tasks");
	addCount(changes, differenceCount(previous.tasks, next.tasks), "task closed", "tasks closed");

	const previousMemory = new Map<string, { text: string; tier: "short-term" | "long-term" }>();
	const nextMemory = new Map<string, { text: string; tier: "short-term" | "long-term" }>();
	for (const item of previous.shortTermMemories) previousMemory.set(item.id, { text: item.text, tier: "short-term" });
	for (const item of previous.longTermMemories) previousMemory.set(item.id, { text: item.text, tier: "long-term" });
	for (const item of next.shortTermMemories) nextMemory.set(item.id, { text: item.text, tier: "short-term" });
	for (const item of next.longTermMemories) nextMemory.set(item.id, { text: item.text, tier: "long-term" });
	let addedMemory = 0;
	let promotedMemory = 0;
	let movedToShortTerm = 0;
	let updatedMemory = 0;
	for (const [id, item] of nextMemory) {
		const old = previousMemory.get(id);
		if (!old) addedMemory += 1;
		else {
			if (old.tier === "short-term" && item.tier === "long-term") promotedMemory += 1;
			if (old.tier === "long-term" && item.tier === "short-term") movedToShortTerm += 1;
			if (old.text !== item.text) updatedMemory += 1;
		}
	}
	const forgottenMemory = [...previousMemory.keys()].filter((id) => !nextMemory.has(id)).length;
	addCount(changes, addedMemory, "new memory", "new memories");
	addCount(changes, promotedMemory, "memory promoted", "memories promoted");
	addCount(changes, movedToShortTerm, "memory moved to short term", "memories moved to short term");
	addCount(changes, updatedMemory, "memory updated", "memories updated");
	addCount(changes, forgottenMemory, "memory forgotten", "memories forgotten");

	const previousFiles = new Map<string, "read" | "outline" | "deferred">();
	const nextFiles = new Map<string, "read" | "outline" | "deferred">();
	for (const path of previous.readFiles) previousFiles.set(path, "read");
	for (const path of previous.outlineFiles) previousFiles.set(path, "outline");
	for (const item of previous.deferFiles) previousFiles.set(item.path, "deferred");
	for (const path of next.readFiles) nextFiles.set(path, "read");
	for (const path of next.outlineFiles) nextFiles.set(path, "outline");
	for (const item of next.deferFiles) nextFiles.set(item.path, "deferred");
	let addedFiles = 0;
	let changedFileTiers = 0;
	for (const [path, tier] of nextFiles) {
		const oldTier = previousFiles.get(path);
		if (!oldTier) addedFiles += 1;
		else if (oldTier !== tier) changedFileTiers += 1;
	}
	const removedFiles = [...previousFiles.keys()].filter((path) => !nextFiles.has(path)).length;
	addCount(changes, addedFiles, "file added", "files added");
	addCount(changes, changedFileTiers, "file tier changed", "file tiers changed");
	addCount(changes, removedFiles, "file removed", "files removed");
	return changes.length > 0 ? changes : ["No changes"];
}

function differenceCount(values: readonly string[], previous: readonly string[]): number {
	const remaining = [...previous];
	let count = 0;
	for (const value of values) {
		const index = remaining.indexOf(value);
		if (index < 0) count += 1;
		else remaining.splice(index, 1);
	}
	return count;
}

function addCount(changes: string[], count: number, singular: string, plural: string): void {
	if (count > 0) changes.push(`${count} ${count === 1 ? singular : plural}`);
}

function boundedWarning(value: string): string {
	return value.length <= 500 ? value : `${value.slice(0, 499)}…`;
}

function assertCurrent(options: ExecuteSessionMemoryOptions): void {
	options.signal?.throwIfAborted();
	if (options.generation !== options.currentGeneration()) {
		throw new Error("Session-memory update crossed a session lifecycle boundary");
	}
}
