import type { AssistantMessage, TextContent, UserMessage } from "@earendil-works/pi-ai";
import { sessionEntryToContextMessages, type ContextEvent, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { formatCheckpointMessage } from "./prompt.ts";

type AgentMessage = ContextEvent["messages"][number];
type ContextPair = { entry: SessionEntry; message: AgentMessage };

const CHECKPOINT_KIND = "checkpoint.checkpoint";
const MESSAGE_ID_METADATA_TYPE = "tau.checkpoint.message-id";

type CheckpointMetadataMessage = Extract<AgentMessage, { role: "custom" }>;

type CheckpointAnchor = {
	call: ContextPair;
	result: ContextPair;
	resultIndex: number;
	toolCallIds: Set<string>;
};

function pairsAlignWithMessages(pairs: readonly ContextPair[], messages: readonly AgentMessage[]): boolean {
	if (pairs.length !== messages.length) return false;
	return !pairs.some((pair, index) => {
		const expected = messageKey(pair.message);
		const actual = messageKey(messages[index]);
		return expected === undefined || actual === undefined || expected !== actual;
	});
}

function findCheckpointResult(
	pairs: readonly ContextPair[],
): { result: ContextPair; resultIndex: number; checkpointId: string; fileBatchId: string } | undefined {
	for (let resultIndex = pairs.length - 1; resultIndex >= 0; resultIndex--) {
		const result = pairs[resultIndex];
		if (result.entry.type !== "message" || result.message.role !== "toolResult") continue;
		const details = checkpointDetails(result.message.details);
		if (details === undefined) continue;
		return { result, resultIndex, checkpointId: details.checkpointId, fileBatchId: details.fileBatchId };
	}
	return undefined;
}

function resolveCheckpointCall(
	pairs: readonly ContextPair[],
	resultIndex: number,
	checkpointId: string,
): { call: ContextPair; toolCallIds: Set<string> } | "misaligned" {
	let callIndex = resultIndex - 1;
	while (callIndex >= 0 && !hasCheckpointToolCall(pairs[callIndex].message, checkpointId)) callIndex--;
	if (callIndex < 0) return "misaligned";
	const call = pairs[callIndex];
	if (call.message.role !== "assistant") return "misaligned";
	const toolCallIds = new Set<string>();
	for (const part of call.message.content) {
		if (part.type === "toolCall") toolCallIds.add(part.id);
	}
	return { call, toolCallIds };
}

function findCheckpointAnchor(pairs: readonly ContextPair[]): CheckpointAnchor | "misaligned" | undefined {
	const found = findCheckpointResult(pairs);
	if (found === undefined) return undefined;
	const resolved = resolveCheckpointCall(pairs, found.resultIndex, found.checkpointId);
	if (resolved === "misaligned") return "misaligned";
	return {
		call: resolved.call,
		result: found.result,
		resultIndex: found.resultIndex,
		toolCallIds: resolved.toolCallIds,
	};
}

function keepCheckpointPair(
	checkpoint: CheckpointAnchor | undefined,
	entry: SessionEntry,
	message: AgentMessage,
	index: number,
): boolean {
	if (checkpoint === undefined) return true;
	if (index > checkpoint.resultIndex) return true;
	if (entry.id === checkpoint.call.entry.id || entry.id === checkpoint.result.entry.id) return true;
	return message.role === "toolResult" && checkpoint.toolCallIds.has(message.toolCallId);
}

function expandPairMessages(entry: SessionEntry, message: AgentMessage): AgentMessage[] {
	if (entry.type === "message" && (entry.message.role === "user" || entry.message.role === "assistant")) {
		return [createMessageIdMetadata(entry.id, message), message];
	}
	return [message];
}

/** Prunes completed checkpoint history and adds hidden provider-context message IDs. */
export function projectContextMessages(
	messages: readonly AgentMessage[],
	entries: readonly SessionEntry[],
): AgentMessage[] {
	const pairs: ContextPair[] = [];
	for (const entry of entries) {
		for (const message of sessionEntryToContextMessages(entry)) pairs.push({ entry, message });
	}

	const checkpoint = findCheckpointAnchor(pairs);
	if (checkpoint === "misaligned") return [...messages];
	if (checkpoint === undefined && !pairsAlignWithMessages(pairs, messages)) return [...messages];

	return pairs
		.filter(({ entry, message }, index) => keepCheckpointPair(checkpoint, entry, message, index))
		.flatMap(({ entry, message }) => expandPairMessages(entry, message));
}

/** Extracts only the original text from a user or assistant message. */
export function extractConversationText(message: AgentMessage): string | undefined {
	if (message.role === "user") return userText(message);
	if (message.role === "assistant") return assistantText(message);
	return undefined;
}

function messageKey(message: AgentMessage): string | undefined {
	return JSON.stringify(message, (key, value) => (key === "timestamp" ? undefined : value));
}

function checkpointDetails(details: unknown): { checkpointId: string; fileBatchId: string } | undefined {
	if (typeof details !== "object" || details === null) return undefined;
	const value = details as Record<string, unknown>;
	if (
		value.v !== 1 ||
		value.kind !== CHECKPOINT_KIND ||
		typeof value.checkpointId !== "string" ||
		typeof value.fileBatchId !== "string"
	)
		return undefined;
	return { checkpointId: value.checkpointId, fileBatchId: value.fileBatchId };
}

function hasCheckpointToolCall(message: AgentMessage, checkpointId: string): boolean {
	return (
		message.role === "assistant" &&
		message.content.some((part) => part.type === "toolCall" && part.name === "checkpoint" && part.id === checkpointId)
	);
}

function createMessageIdMetadata(id: string, message: AgentMessage): CheckpointMetadataMessage {
	const role = message.role === "user" ? "user" : "assistant";
	return {
		role: "custom",
		customType: MESSAGE_ID_METADATA_TYPE,
		content: formatCheckpointMessage(
			"message-id",
			`<message-id>${JSON.stringify(id)}</message-id>\n<message-role>${role}</message-role>`,
		),
		display: false,
		details: { v: 1, kind: "checkpoint.message-id", id, role },
		timestamp: message.timestamp,
	};
}

function userText(message: UserMessage): string {
	if (typeof message.content === "string") return message.content;
	return message.content
		.filter((part): part is TextContent => part.type === "text")
		.map((part) => part.text)
		.join("");
}

function assistantText(message: AssistantMessage): string {
	return message.content
		.filter((part): part is TextContent => part.type === "text")
		.map((part) => part.text)
		.join("");
}
