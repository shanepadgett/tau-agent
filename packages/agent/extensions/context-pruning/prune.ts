import {
	estimateTokens,
	type ContextEvent,
	type ExtensionAPI,
	type ExtensionContext,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import type { ContextPruneDeferredFileV1, ContextPruneDetailsV1 } from "../../shared/context-pruning-state.ts";
import { canonicalizeFileSelections, selectFileEvidence } from "./file-evidence.ts";

type ContextMessage = ContextEvent["messages"][number];

export const contextPruneParameters = Type.Object(
	{
		keepFiles: Type.Array(
			Type.Object(
				{
					path: Type.String(),
					relevance: Type.String(),
				},
				{ additionalProperties: false },
			),
		),
		keepToolCalls: Type.Array(
			Type.Object(
				{
					toolCallId: Type.String(),
					relevance: Type.String(),
				},
				{ additionalProperties: false },
			),
		),
		deferFiles: Type.Array(
			Type.Object(
				{
					path: Type.String(),
					reason: Type.String(),
					relevantWhen: Type.String(),
				},
				{ additionalProperties: false },
			),
		),
	},
	{ additionalProperties: false },
);

export type ContextPruneInput = Static<typeof contextPruneParameters>;

interface ProjectionSnapshot {
	generation: number;
	messages: ContextEvent["messages"];
}

interface ContextPruneExecutionOptions {
	pi: Pick<ExtensionAPI, "sendMessage">;
	toolCallId: string;
	params: ContextPruneInput;
	signal: AbortSignal | undefined;
	ctx: ExtensionContext;
	projection: ProjectionSnapshot | undefined;
	currentGeneration: () => number;
	currentEnabled: () => boolean;
	minimumReclaimTokens: number;
}

interface ContextPruneExecutionResult {
	content: Array<{ type: "text"; text: string }>;
	details: ContextPruneDetailsV1;
}

interface PreparedPrune {
	messages: Array<Parameters<ExtensionAPI["sendMessage"]>[0]>;
	result: ContextPruneExecutionResult;
}

export async function executeContextPrune(options: ContextPruneExecutionOptions): Promise<ContextPruneExecutionResult> {
	const skipped = (reason: string, estimates = { before: 0, after: 0 }): ContextPruneExecutionResult => ({
		content: [{ type: "text", text: `Prune skipped: ${reason} Continue the task without immediately retrying.` }],
		details: {
			v: 1,
			status: "skipped",
			anchorToolCallId: options.toolCallId,
			newlyPrunedToolCallIds: [],
			newlyPrunedAutoreadRowIds: [],
			retainedToolCallIds: [],
			retainedAutoreadRowIds: [],
			refreshedFiles: [],
			deferredFiles: [],
			tokensBefore: estimates.before,
			tokensAfter: estimates.after,
			tokensReclaimed: estimates.before - estimates.after,
		},
	});

	if (!options.currentEnabled()) return skipped("context pruning is disabled.");
	options.signal?.throwIfAborted();
	const projection = options.projection;
	if (!projection || projection.generation !== options.currentGeneration()) {
		return skipped("the latest provider-context projection is unavailable.");
	}
	const currentAssistant = findCurrentAssistant(options.ctx.sessionManager.buildContextEntries(), options.toolCallId);
	if (!currentAssistant) return skipped("the current context_prune call is absent from the active branch.");
	const currentToolCalls = currentAssistant.content.filter((block) => block.type === "toolCall");
	if (
		currentToolCalls.length !== 1 ||
		currentToolCalls[0]?.id !== options.toolCallId ||
		currentToolCalls[0]?.name !== "context_prune"
	) {
		return skipped("context_prune must be the only tool call in its assistant message.");
	}

	let pairs: Set<string>;
	let autoreads: Map<string, ContextMessage>;
	let preparedPrune: PreparedPrune;
	try {
		pairs = indexCompleteToolPairs(projection.messages);
		autoreads = indexAutoreads(projection.messages);
	} catch (error) {
		return skipped(errorMessage(error));
	}

	const explicitlyRetained = new Set<string>();
	for (const selection of options.params.keepToolCalls) {
		if (explicitlyRetained.has(selection.toolCallId)) {
			return skipped(`tool-call ID ${selection.toolCallId} was selected more than once.`);
		}
		if (!pairs.has(selection.toolCallId)) {
			return skipped(`tool-call ID ${selection.toolCallId} is not a complete currently projected exchange.`);
		}
		explicitlyRetained.add(selection.toolCallId);
	}

	try {
		const canonical = await canonicalizeFileSelections({
			cwd: options.ctx.cwd,
			keepFiles: options.params.keepFiles,
			deferFiles: options.params.deferFiles,
		});
		const fileEvidence = await selectFileEvidence({
			cwd: options.ctx.cwd,
			messages: projection.messages,
			files: canonical.keepFiles,
			anchorToolCallId: options.toolCallId,
			signal: options.signal,
			isLifecycleCurrent: () => projection.generation === options.currentGeneration(),
		});
		options.signal?.throwIfAborted();
		if (projection.generation !== options.currentGeneration()) {
			throw new Error("Prune preparation crossed a session lifecycle boundary");
		}

		const retainedTools = new Set([...explicitlyRetained, ...fileEvidence.retainedToolCallIds]);
		const retainedAutoreads = new Set(fileEvidence.retainedAutoreadRowIds);
		const retainedToolCallIds = [...pairs.keys()].filter((id) => retainedTools.has(id));
		const retainedAutoreadRowIds = [
			...[...autoreads.keys()].filter((id) => retainedAutoreads.has(id)),
			...fileEvidence.preparedSnapshots.map((snapshot) => snapshot.details.rowId),
		];
		const newlyPrunedToolCallIds = [...pairs.keys()].filter((id) => !retainedTools.has(id));
		const newlyPrunedAutoreadRowIds = [...autoreads.keys()].filter((id) => !retainedAutoreads.has(id));
		const deferredFiles: ContextPruneDeferredFileV1[] = canonical.deferFiles.map((file) => ({
			path: file.displayPath,
			reason: file.request.reason,
			relevantWhen: file.request.relevantWhen,
		}));
		const deferredMessage = deferredFiles.length === 0 ? undefined : createDeferredMessage(deferredFiles);
		const beforeMessages = [...projection.messages, currentAssistant];
		const afterMessages = projectCandidate(
			beforeMessages,
			new Set(newlyPrunedToolCallIds),
			new Set(newlyPrunedAutoreadRowIds),
		);
		for (const prepared of fileEvidence.preparedSnapshots) {
			afterMessages.push({
				role: "custom",
				customType: prepared.customType,
				content: prepared.content,
				display: prepared.display,
				details: prepared.details,
				timestamp: 0,
			});
		}
		if (deferredMessage) afterMessages.push({ role: "custom", ...deferredMessage, timestamp: 0 });
		const tokensBefore = beforeMessages.reduce((total, message) => total + estimateTokens(message), 0);
		const tokensAfter = afterMessages.reduce((total, message) => total + estimateTokens(message), 0);
		const tokensReclaimed = tokensBefore - tokensAfter;
		if (tokensReclaimed < options.minimumReclaimTokens) {
			return skipped(
				`estimated reclaim is ${tokensReclaimed} tokens, below the ${options.minimumReclaimTokens}-token minimum.`,
				{ before: tokensBefore, after: tokensAfter },
			);
		}

		options.signal?.throwIfAborted();
		if (projection.generation !== options.currentGeneration()) {
			throw new Error("Prune preparation crossed a session lifecycle boundary");
		}
		const details: ContextPruneDetailsV1 = {
			v: 1,
			status: "applied",
			anchorToolCallId: options.toolCallId,
			newlyPrunedToolCallIds,
			newlyPrunedAutoreadRowIds,
			retainedToolCallIds,
			retainedAutoreadRowIds,
			refreshedFiles: [...fileEvidence.refreshedFiles],
			deferredFiles,
			tokensBefore,
			tokensAfter,
			tokensReclaimed,
		};
		preparedPrune = {
			messages: [...fileEvidence.preparedSnapshots, ...(deferredMessage === undefined ? [] : [deferredMessage])],
			result: {
				content: [
					{
						type: "text",
						text: `Prune applied: reclaimed about ${tokensReclaimed} tokens. Continue with the next action stated before this call.`,
					},
				],
				details,
			},
		};
	} catch (error) {
		if (options.signal?.aborted) throw error;
		if (projection.generation !== options.currentGeneration()) throw error;
		return skipped(errorMessage(error));
	}

	// Pi synchronously enqueues steering messages. Keep this commit outside preparation's
	// failure-to-skipped boundary so a publication error can never masquerade as an atomic no-op.
	for (const message of preparedPrune.messages) options.pi.sendMessage(message, { deliverAs: "steer" });
	return preparedPrune.result;
}

function indexCompleteToolPairs(messages: readonly ContextMessage[]): Set<string> {
	const calls = new Map<string, { name: string; index: number }>();
	const results = new Map<string, { name: string; index: number }>();
	for (let index = 0; index < messages.length; index += 1) {
		const message = messages[index];
		if (!message) continue;
		if (message.role === "assistant") {
			for (const block of message.content) {
				if (block.type !== "toolCall") continue;
				if (calls.has(block.id)) throw new Error(`Duplicate projected tool-call ID: ${block.id}.`);
				calls.set(block.id, { name: block.name, index });
			}
		} else if (message.role === "toolResult") {
			if (results.has(message.toolCallId))
				throw new Error(`Duplicate projected tool result: ${message.toolCallId}.`);
			results.set(message.toolCallId, { name: message.toolName, index });
		}
	}
	const pairs = new Set<string>();
	for (const [id, call] of calls) {
		const result = results.get(id);
		if (!result || result.name !== call.name || result.index <= call.index) {
			throw new Error(`Incomplete projected tool exchange: ${id}.`);
		}
		pairs.add(id);
	}
	for (const id of results.keys()) if (!calls.has(id)) throw new Error(`Orphaned projected tool result: ${id}.`);
	return pairs;
}

function indexAutoreads(messages: readonly ContextMessage[]): Map<string, ContextMessage> {
	const rows = new Map<string, ContextMessage>();
	for (const message of messages) {
		if (message.role !== "custom" || message.customType !== "tau.autoread") continue;
		if (
			!isRecord(message.details) ||
			typeof message.details.rowId !== "string" ||
			message.details.rowId.length === 0
		) {
			throw new Error("Projected autoread evidence has no stable row ID.");
		}
		if (rows.has(message.details.rowId))
			throw new Error(`Duplicate projected autoread row: ${message.details.rowId}.`);
		rows.set(message.details.rowId, message);
	}
	return rows;
}

function findCurrentAssistant(
	branch: readonly SessionEntry[],
	toolCallId: string,
): Extract<ContextMessage, { role: "assistant" }> | undefined {
	for (let index = branch.length - 1; index >= 0; index -= 1) {
		const entry = branch[index];
		if (entry?.type !== "message" || entry.message.role !== "assistant") continue;
		if (entry.message.content.some((block) => block.type === "toolCall" && block.id === toolCallId))
			return entry.message;
	}
	return undefined;
}

function projectCandidate(
	messages: readonly ContextMessage[],
	prunedToolIds: ReadonlySet<string>,
	prunedAutoreadIds: ReadonlySet<string>,
): ContextMessage[] {
	const projected: ContextMessage[] = [];
	for (const message of messages) {
		if (message.role === "toolResult" && prunedToolIds.has(message.toolCallId)) continue;
		if (
			message.role === "custom" &&
			(message.customType === "tau.context-pruning.nudge" || message.customType === "tau.context-pruning.deferred")
		)
			continue;
		if (message.role === "custom" && message.customType === "tau.autoread" && isRecord(message.details)) {
			const rowId = message.details.rowId;
			if (typeof rowId === "string" && prunedAutoreadIds.has(rowId)) continue;
		}
		if (message.role !== "assistant") {
			projected.push(message);
			continue;
		}
		const content = message.content.filter(
			(block) => block.type !== "thinking" && !(block.type === "toolCall" && prunedToolIds.has(block.id)),
		);
		if (content.length > 0)
			projected.push(content.length === message.content.length ? message : { ...message, content });
	}
	return projected;
}

function createDeferredMessage(files: readonly ContextPruneDeferredFileV1[]) {
	return {
		customType: "tau.context-pruning.deferred" as const,
		content: [
			"Deferred files are advisory. Reconsider them only when their condition applies:",
			...files.map((file) => `- ${file.path}: ${file.reason} Relevant when: ${file.relevantWhen}`),
		].join("\n"),
		display: false as const,
		details: { v: 1 as const, files },
	};
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
