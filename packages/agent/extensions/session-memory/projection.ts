import { sessionEntryToContextMessages, type ContextEvent, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { SESSION_MEMORY_TOOL, type ReplayedSessionMemory } from "./state.ts";

type ContextMessage = ContextEvent["messages"][number];

export const TASK_REMINDER_TOOL_RESULTS = 10;

const TASK_REMINDER_TYPE = "tau.session-memory.task-reminder";
const TASK_REMINDER =
	"Reconcile session memory tasks. Keep only unfinished work, current task first, and remove completed or abandoned tasks. Before a final response, update session memory if saved state changed.";

export interface ProjectionResult {
	messages: ContextMessage[];
	projectedCheckpointId: string | undefined;
}

export function projectSessionMemory(
	messages: readonly ContextMessage[],
	replay: ReplayedSessionMemory,
): ProjectionResult {
	const checkpoint = replay.latestCheckpoint;
	if (!checkpoint || !replay.latestCheckpointText) {
		return withTaskReminder(messages, replay, undefined);
	}
	const anchorIndex = findAnchor(messages, checkpoint.toolCallId);
	if (anchorIndex < 0) {
		const recovery: ContextMessage = {
			role: "custom",
			customType: "tau.session-memory.recovery",
			content: replay.recoveryText ?? replay.latestCheckpointText,
			display: false,
			timestamp: 0,
		};
		const compactionIndex = findLastCompaction(messages);
		const projected = [...messages];
		projected.splice(compactionIndex + 1, 0, recovery);
		return withTaskReminder(projected, replay, checkpoint.toolCallId);
	}

	const anchor = messages[anchorIndex];
	if (!anchor || anchor.role !== "assistant") {
		return withTaskReminder(messages, replay, undefined);
	}
	const siblingIds = new Set(
		anchor.content
			.filter((item) => item.type === "toolCall" && item.id !== checkpoint.toolCallId)
			.map((item) => (item.type === "toolCall" ? item.id : "")),
	);
	const resultIndex = messages.findIndex(
		(message, index) =>
			index > anchorIndex &&
			message.role === "toolResult" &&
			message.toolName === SESSION_MEMORY_TOOL &&
			message.toolCallId === checkpoint.toolCallId,
	);
	if (resultIndex < 0) return withTaskReminder(messages, replay, undefined);

	const projected: ContextMessage[] = [sanitizeAnchor(anchor, checkpoint.toolCallId)];
	for (let index = anchorIndex + 1; index < messages.length; index += 1) {
		const message = messages[index];
		if (!message) continue;
		if (message.role === "toolResult" && siblingIds.has(message.toolCallId)) continue;
		if (index < resultIndex) continue;
		projected.push(message);
	}
	return withTaskReminder(projected, replay, checkpoint.toolCallId);
}

function withTaskReminder(
	messages: readonly ContextMessage[],
	replay: ReplayedSessionMemory,
	projectedCheckpointId: string | undefined,
): ProjectionResult {
	const projected = messages.filter(
		(message) => message.role !== "custom" || message.customType !== TASK_REMINDER_TYPE,
	);
	if (replay.successfulToolResultsSinceUpdate >= TASK_REMINDER_TOOL_RESULTS) {
		projected.push({
			role: "custom",
			customType: TASK_REMINDER_TYPE,
			content: TASK_REMINDER,
			display: false,
			timestamp: 0,
		});
	}
	return { messages: projected, projectedCheckpointId };
}

export function collectPrunedRowIds(branch: readonly SessionEntry[], before: number): string[] {
	const rows = new Set<string>();
	for (let index = 0; index < before; index += 1) {
		const entry = branch[index];
		if (!entry) continue;
		for (const message of sessionEntryToContextMessages(entry)) {
			if (message.role === "assistant") {
				for (const block of message.content) {
					if (block.type === "toolCall" && block.name !== SESSION_MEMORY_TOOL) rows.add(block.id);
				}
			}
			if (
				message.role === "custom" &&
				(message.customType === "tau.explore.outline" || message.customType === "tau.autoread") &&
				isRecord(message.details) &&
				typeof message.details.rowId === "string"
			) {
				rows.add(message.details.rowId);
			}
		}
	}
	return [...rows];
}

export function findToolCallEntry(branch: readonly SessionEntry[], toolCallId: string): number {
	for (let index = branch.length - 1; index >= 0; index -= 1) {
		const entry = branch[index];
		if (
			entry?.type === "message" &&
			entry.message.role === "assistant" &&
			entry.message.content.some(
				(item) => item.type === "toolCall" && item.name === SESSION_MEMORY_TOOL && item.id === toolCallId,
			)
		)
			return index;
	}
	return -1;
}

function sanitizeAnchor(message: Extract<ContextMessage, { role: "assistant" }>, toolCallId: string): ContextMessage {
	return {
		...message,
		content: message.content.flatMap((item) =>
			item.type === "toolCall" && item.name === SESSION_MEMORY_TOOL && item.id === toolCallId
				? [{ ...item, arguments: { action: "checkpoint" } }]
				: [],
		),
	};
}

function findAnchor(messages: readonly ContextMessage[], toolCallId: string): number {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (
			message?.role === "assistant" &&
			message.content.some(
				(item) => item.type === "toolCall" && item.name === SESSION_MEMORY_TOOL && item.id === toolCallId,
			)
		)
			return index;
	}
	return -1;
}

function findLastCompaction(messages: readonly ContextMessage[]): number {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		if (messages[index]?.role === "compactionSummary") return index;
	}
	return -1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
