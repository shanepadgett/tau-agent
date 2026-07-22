import type { ContextEvent } from "@earendil-works/pi-coding-agent";
import type { ActiveContextPruningState } from "../../shared/context-pruning-state.ts";

type ContextMessage = ContextEvent["messages"][number];

const NUDGE_MESSAGE_TYPE = "tau.context-pruning.nudge";
const DEFERRED_MESSAGE_TYPE = "tau.context-pruning.deferred";

export function projectContext(
	messages: readonly ContextMessage[],
	state: ActiveContextPruningState,
): ContextMessage[] {
	const abandonedToolCallIds = new Set<string>();
	const inputPairs = indexToolPairs(messages, abandonedToolCallIds);
	const anchorBoundary = visibleAnchorBoundary(messages, state.latestAnchorToolCallId, inputPairs);
	const prunedToolCallIds = state.latestAnchorToolCallId === undefined ? new Set<string>() : state.prunedToolCallIds;
	const prunedAutoreadRowIds =
		state.latestAnchorToolCallId === undefined ? new Set<string>() : state.prunedAutoreadRowIds;
	const projected: ContextMessage[] = [];

	for (let index = 0; index < messages.length; index += 1) {
		const message = messages[index];
		if (message.role === "toolResult" && prunedToolCallIds.has(message.toolCallId)) continue;
		if (
			message.role === "custom" &&
			message.customType === "tau.autoread" &&
			isPrunedAutoread(message.details, prunedAutoreadRowIds)
		)
			continue;
		if (
			anchorBoundary !== undefined &&
			index <= anchorBoundary &&
			message.role === "custom" &&
			(message.customType === NUDGE_MESSAGE_TYPE || message.customType === DEFERRED_MESSAGE_TYPE)
		)
			continue;
		if (message.role !== "assistant") {
			projected.push(message);
			continue;
		}

		const removeThinking = anchorBoundary !== undefined && index <= anchorBoundary;
		let changed = false;
		const content = message.content.filter((block) => {
			const remove =
				(removeThinking && block.type === "thinking") ||
				(block.type === "toolCall" && (prunedToolCallIds.has(block.id) || abandonedToolCallIds.has(block.id)));
			if (remove) changed = true;
			return !remove;
		});
		if (content.length === 0) continue;
		projected.push(changed ? { ...message, content } : message);
	}

	indexToolPairs(projected);
	return projected;
}

function isPrunedAutoread(value: unknown, prunedRowIds: ReadonlySet<string>): boolean {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const rowId = (value as Record<string, unknown>).rowId;
	return typeof rowId === "string" && prunedRowIds.has(rowId);
}

function visibleAnchorBoundary(
	messages: readonly ContextMessage[],
	anchorToolCallId: string | undefined,
	pairs: ReadonlyMap<string, { callIndex: number; resultIndex: number }>,
): number | undefined {
	if (anchorToolCallId === undefined) return undefined;
	const pair = pairs.get(anchorToolCallId);
	if (!pair) return undefined;
	const call = messages[pair.callIndex];
	const result = messages[pair.resultIndex];
	if (call?.role !== "assistant" || result?.role !== "toolResult" || result.toolName !== "context_prune")
		return undefined;
	const block = call.content.find((item) => item.type === "toolCall" && item.id === anchorToolCallId);
	return block?.type === "toolCall" && block.name === "context_prune" ? pair.resultIndex : undefined;
}

function indexToolPairs(
	messages: readonly ContextMessage[],
	abandonedToolCallIds?: Set<string>,
): Map<string, { callIndex: number; resultIndex: number }> {
	const calls = new Map<string, { index: number; aborted: boolean }>();
	const results = new Map<string, number>();
	for (let index = 0; index < messages.length; index += 1) {
		const message = messages[index];
		if (message.role === "assistant") {
			for (const block of message.content) {
				if (block.type !== "toolCall") continue;
				if (calls.has(block.id)) throw new Error(`Duplicate tool call in projected context: ${block.id}`);
				calls.set(block.id, { index, aborted: message.stopReason === "aborted" });
			}
		} else if (message.role === "toolResult") {
			if (results.has(message.toolCallId))
				throw new Error(`Duplicate tool result in projected context: ${message.toolCallId}`);
			results.set(message.toolCallId, index);
		}
	}

	const pairs = new Map<string, { callIndex: number; resultIndex: number }>();
	for (const [id, call] of calls) {
		const resultIndex = results.get(id);
		if (resultIndex === undefined) {
			if (call.aborted && abandonedToolCallIds) {
				abandonedToolCallIds.add(id);
				continue;
			}
			throw new Error(`Orphaned tool call in projected context: ${id}`);
		}
		pairs.set(id, { callIndex: call.index, resultIndex });
	}
	for (const id of results.keys()) {
		if (!calls.has(id)) throw new Error(`Orphaned tool result in projected context: ${id}`);
	}
	return pairs;
}
