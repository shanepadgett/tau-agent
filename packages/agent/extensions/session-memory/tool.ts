import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PreparedOutlineInjection } from "../../shared/outline-injection.ts";
import { requestOutlineInjections } from "../../shared/outline-injection.ts";
import { collectPrunedRowIds, findToolCallEntry } from "./projection.ts";
import {
	assertSnapshotBound,
	checkpointState,
	formatSessionMemory,
	normalizeUpdate,
	replaySessionMemory,
	type SessionMemoryDetailsV1,
	type SessionMemoryInput,
	type SessionMemoryState,
} from "./state.ts";

interface ExecuteSessionMemoryOptions {
	pi: Pick<ExtensionAPI, "events">;
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
		details: SessionMemoryDetailsV1;
	};
	outlines: PreparedOutlineInjection[];
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
		if (replay.latest && replay.latest.state.goal !== state.goal) {
			if (!options.ctx.hasUI) {
				throw new Error("Goal change requires user approval. Keep the current goal and ask the user first.");
			}
			const approved = await options.ctx.ui.confirm("Change session goal?", state.goal);
			if (!approved) throw new Error("Session goal change was not approved");
		}
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
	const outlineResponse = checkpointing
		? await requestOutlineInjections(options.pi, {
				cwd: options.ctx.cwd,
				batchId: `${options.toolCallId}:outline`,
				paths: state.outlineFiles,
				signal: options.signal,
				isLifecycleCurrent: () => options.generation === options.currentGeneration(),
			})
		: { messages: [], warnings: [] };
	warnings.push(...outlineResponse.warnings.map(boundedWarning));
	assertCurrent(options);

	const newOutlineRows = new Map(
		outlineResponse.messages.map(
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
	const details: SessionMemoryDetailsV1 = {
		v: 1,
		toolCallId: options.toolCallId,
		kind: checkpointing ? "checkpoint" : "update",
		checkpoint: nextCheckpoint,
		state,
		outlinedRows,
		prunedRowIds,
		warnings,
	};
	return {
		result: { content: [{ type: "text", text: formatSessionMemory(state, nextCheckpoint, warnings) }], details },
		outlines: outlineResponse.messages,
		readFiles,
	};
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
