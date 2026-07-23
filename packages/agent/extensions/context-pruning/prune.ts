import { resolve } from "node:path";
import {
	type ExtensionContext,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import type {
	ContextPruneDeferredFileV2,
	ContextPruneDetailsV2,
} from "../../shared/context-pruning-state.ts";
import { prepareAutoreadMessage, type PreparedAutoreadMessage } from "../explore/autoread.ts";
import { MAX_COMPLETE_FILE_SNAPSHOT_BYTES } from "../explore/full-file-knowledge.ts";

export const contextPruneParameters = Type.Object(
	{
		keepFiles: Type.Array(
			Type.Object({ path: Type.String(), relevance: Type.String() }, { additionalProperties: false }),
		),
		keepToolCalls: Type.Array(
			Type.Object({ toolCallId: Type.String(), relevance: Type.String() }, { additionalProperties: false }),
		),
		deferFiles: Type.Array(
			Type.Object(
				{ path: Type.String(), reason: Type.String(), relevantWhen: Type.String() },
				{ additionalProperties: false },
			),
		),
	},
	{ additionalProperties: false },
);

export type ContextPruneInput = Static<typeof contextPruneParameters>;

interface ContextPruneExecutionOptions {
	toolCallId: string;
	params: ContextPruneInput;
	signal: AbortSignal | undefined;
	ctx: ExtensionContext;
	generation: number;
	currentGeneration: () => number;
}

interface ContextPruneExecutionResult {
	content: Array<{ type: "text"; text: string }>;
	details: ContextPruneDetailsV2;
}

export async function executeContextPrune(options: ContextPruneExecutionOptions): Promise<ContextPruneExecutionResult> {
	assertCurrent(options);
	const retainedToolCallIds = [...new Set(options.params.keepToolCalls.map((selection) => selection.toolCallId))];
	const retainedTools = new Set(retainedToolCallIds);
	const { prunedToolCallIds, prunedAutoreadRowIds } = collectPrunedRows(
		options.ctx.sessionManager.getBranch(),
		options.toolCallId,
		retainedTools,
	);
	const warnings: string[] = [];
	const preparedSnapshots: PreparedAutoreadMessage[] = [];
	const keptPaths = new Set<string>();
	for (const selection of options.params.keepFiles) {
		assertCurrent(options);
		const path = normalizePath(selection.path);
		const pathKey = resolve(options.ctx.cwd, path);
		if (keptPaths.has(pathKey)) continue;
		keptPaths.add(pathKey);
		try {
			preparedSnapshots.push(
				await prepareAutoreadMessage({
					rowId: `${options.toolCallId}:${preparedSnapshots.length}`,
					path,
					cwd: options.ctx.cwd,
					source: "context-pruning",
					batchId: options.toolCallId,
					signal: options.signal,
					isLifecycleCurrent: () => options.generation === options.currentGeneration(),
					maximumBytes: MAX_COMPLETE_FILE_SNAPSHOT_BYTES,
				}),
			);
		} catch (error) {
			if (options.signal?.aborted || options.generation !== options.currentGeneration()) throw error;
			warnings.push(`${path}: ${errorMessage(error)}`);
		}
	}

	const deferredFiles: ContextPruneDeferredFileV2[] = [];
	const deferredPaths = new Set<string>();
	for (const selection of options.params.deferFiles) {
		const path = normalizePath(selection.path);
		const pathKey = resolve(options.ctx.cwd, path);
		if (keptPaths.has(pathKey) || deferredPaths.has(pathKey)) continue;
		deferredPaths.add(pathKey);
		deferredFiles.push({ path, reason: selection.reason, relevantWhen: selection.relevantWhen });
	}
	assertCurrent(options);

	const retainedAutoreadRowIds = preparedSnapshots.map((snapshot) => snapshot.details.rowId);
	const refreshedFiles = preparedSnapshots.map((snapshot) => ({
		path: snapshot.details.path,
		rowId: snapshot.details.rowId,
		servedHash: snapshot.details.readCache.servedHash,
		autoreadDetails: { ...snapshot.details },
	}));
	const details: ContextPruneDetailsV2 = {
		v: 2,
		anchorToolCallId: options.toolCallId,
		prunedToolCallIds,
		prunedAutoreadRowIds,
		retainedToolCallIds,
		retainedAutoreadRowIds,
		refreshedFiles,
		deferredFiles,
		warnings,
	};
	const status =
		warnings.length === 0
			? "Context checkpoint applied. Continue with the next action stated before this call."
			: `Context checkpoint applied with ${warnings.length} warning${warnings.length === 1 ? "" : "s"}:\n${warnings.map((warning) => `- ${warning}`).join("\n")}\nContinue with the next action stated before this call.`;
	return {
		content: [
			{ type: "text", text: status },
			...preparedSnapshots.map((snapshot) => ({ type: "text" as const, text: snapshot.content })),
			...(deferredFiles.length === 0
				? []
				: [{ type: "text" as const, text: deferredFileText(deferredFiles) }]),
		],
		details,
	};
}

function collectPrunedRows(
	branch: readonly SessionEntry[],
	anchorToolCallId: string,
	retainedToolCallIds: ReadonlySet<string>,
): { prunedToolCallIds: string[]; prunedAutoreadRowIds: string[] } {
	let anchorIndex = -1;
	for (let index = branch.length - 1; index >= 0; index -= 1) {
		const entry = branch[index];
		if (
			entry?.type === "message" &&
			entry.message.role === "assistant" &&
			entry.message.content.some(
				(block) => block.type === "toolCall" && block.id === anchorToolCallId && block.name === "context_prune",
			)
		) {
			anchorIndex = index;
			break;
		}
	}
	if (anchorIndex < 0) return { prunedToolCallIds: [], prunedAutoreadRowIds: [] };
	const prunedToolCallIds = new Set<string>();
	const prunedAutoreadRowIds = new Set<string>();
	for (let index = 0; index < anchorIndex; index += 1) {
		const entry = branch[index];
		if (entry?.type === "message" && entry.message.role === "assistant") {
			for (const block of entry.message.content) {
				if (block.type === "toolCall" && !retainedToolCallIds.has(block.id)) prunedToolCallIds.add(block.id);
			}
			continue;
		}
		if (entry?.type !== "custom_message" || entry.customType !== "tau.autoread") continue;
		if (isRecord(entry.details) && typeof entry.details.rowId === "string") {
			prunedAutoreadRowIds.add(entry.details.rowId);
		}
		continue;
	}
	for (let index = 0; index < anchorIndex; index += 1) {
		const entry = branch[index];
		if (entry?.type !== "message" || entry.message.role !== "toolResult") continue;
		if (entry.message.toolName !== "context_prune" || !isRecord(entry.message.details)) continue;
		const files = entry.message.details.refreshedFiles;
		if (!Array.isArray(files)) continue;
		for (const file of files) if (isRecord(file) && typeof file.rowId === "string") prunedAutoreadRowIds.add(file.rowId);
	}
	return { prunedToolCallIds: [...prunedToolCallIds], prunedAutoreadRowIds: [...prunedAutoreadRowIds] };
}

function deferredFileText(files: readonly ContextPruneDeferredFileV2[]): string {
	return [
		"Deferred files are advisory. Reconsider them only when their condition applies:",
		...files.map((file) => `- ${file.path}: ${file.reason} Relevant when: ${file.relevantWhen}`),
	].join("\n");
}

function normalizePath(path: string): string {
	return path.replace(/^@/, "");
}

function assertCurrent(options: ContextPruneExecutionOptions): void {
	options.signal?.throwIfAborted();
	if (options.generation !== options.currentGeneration()) {
		throw new Error("Context checkpoint crossed a session lifecycle boundary");
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
