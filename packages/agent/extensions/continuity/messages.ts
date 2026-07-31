import type { AssistantMessage, TextContent, UserMessage } from "@earendil-works/pi-ai";
import { sessionEntryToContextMessages, type ContextEvent, type SessionEntry } from "@earendil-works/pi-coding-agent";

type AgentMessage = ContextEvent["messages"][number];
type ContextPair = { entry: SessionEntry; message: AgentMessage };

const CHECKPOINT_KIND = "continuity.checkpoint";
const CONTINUITY_SOURCE = "continuity";
const MESSAGE_ID_METADATA_TYPE = "tau.continuity.message-id";
const MESSAGE_ID_METADATA_INSTRUCTION =
	"Internal continuity metadata for the next conversation message. Use its exact ID only in checkpoint.keepMessages. Never quote, repeat, or mention this metadata in a response.";

type ContinuityMetadataMessage = Extract<AgentMessage, { role: "custom" }>;

/** Prunes completed checkpoint history and adds hidden provider-context message IDs. */
export function projectContextMessages(
	messages: readonly AgentMessage[],
	entries: readonly SessionEntry[],
): AgentMessage[] {
	const pairs: ContextPair[] = [];
	for (const entry of entries) {
		for (const message of sessionEntryToContextMessages(entry)) pairs.push({ entry, message });
	}
	if (
		pairs.length !== messages.length ||
		pairs.some((pair, index) => {
			const expected = messageKey(pair.message);
			const actual = messageKey(messages[index]);
			return expected === undefined || actual === undefined || expected !== actual;
		})
	)
		return [...messages];

	let checkpoint:
		| { call: ContextPair; result: ContextPair; resultIndex: number; toolCallIds: Set<string>; fileBatchId: string }
		| undefined;
	for (let resultIndex = pairs.length - 1; resultIndex >= 0; resultIndex--) {
		const result = pairs[resultIndex];
		if (result.entry.type !== "message" || result.message.role !== "toolResult") continue;
		const details = checkpointDetails(result.message.details);
		if (details === undefined) continue;
		let callIndex = resultIndex - 1;
		while (callIndex >= 0 && !hasCheckpointToolCall(pairs[callIndex].message, details.checkpointId)) callIndex--;
		if (callIndex < 0) return [...messages];
		const call = pairs[callIndex];
		if (call.message.role !== "assistant") return [...messages];
		const toolCallIds = new Set<string>();
		for (const part of call.message.content) {
			if (part.type === "toolCall") toolCallIds.add(part.id);
		}
		checkpoint = { call, result, resultIndex, toolCallIds, fileBatchId: details.fileBatchId };
		break;
	}

	return pairs
		.filter(({ entry, message }, index) => {
			if (checkpoint === undefined) return true;
			const batchId = continuityBatchId(entry);
			if (index > checkpoint.resultIndex) return batchId === undefined || batchId === checkpoint.fileBatchId;
			if (entry.id === checkpoint.call.entry.id || entry.id === checkpoint.result.entry.id) return true;
			if (batchId === checkpoint.fileBatchId) return true;
			return message.role === "toolResult" && checkpoint.toolCallIds.has(message.toolCallId);
		})
		.flatMap(({ entry, message }) => {
			if (entry.type === "message" && (entry.message.role === "user" || entry.message.role === "assistant")) {
				return [createMessageIdMetadata(entry.id, message), message];
			}
			return [message];
		});
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

function continuityBatchId(entry: SessionEntry): string | undefined {
	if (entry.type !== "custom_message") return undefined;
	if (typeof entry.details !== "object" || entry.details === null) return undefined;
	const details = entry.details as Record<string, unknown>;
	if (details.source !== CONTINUITY_SOURCE || typeof details.batchId !== "string") return undefined;
	return details.batchId;
}

function createMessageIdMetadata(id: string, message: AgentMessage): ContinuityMetadataMessage {
	const role = message.role === "user" ? "user" : "assistant";
	return {
		role: "custom",
		customType: MESSAGE_ID_METADATA_TYPE,
		content: `${MESSAGE_ID_METADATA_INSTRUCTION}\n<message-id>${JSON.stringify(id)}</message-id>\n<message-role>${role}</message-role>`,
		display: false,
		details: { v: 1, kind: "continuity.message-id", id, role },
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
