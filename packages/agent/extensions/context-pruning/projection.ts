import type { ContextEvent } from "@earendil-works/pi-coding-agent";
import type { ActiveContextPruningState } from "../../shared/context-pruning-state.ts";

type ContextMessage = ContextEvent["messages"][number];

export function projectContext(
	messages: readonly ContextMessage[],
	state: ActiveContextPruningState,
): ContextMessage[] {
	if (state.latestAnchorToolCallId === undefined) return [...messages];
	let anchorIndex = -1;
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (
			message?.role === "assistant" &&
			message.content.some(
				(block) =>
					block.type === "toolCall" && block.id === state.latestAnchorToolCallId && block.name === "context_prune",
			)
		) {
			anchorIndex = index;
			break;
		}
	}
	if (anchorIndex < 0) return [...messages];
	const retainedCallNames = new Map<string, string>();
	const retainedResultNames = new Map<string, string>();
	for (let index = 0; index < anchorIndex; index += 1) {
		const message = messages[index];
		if (message?.role === "assistant") {
			for (const block of message.content) {
				if (block.type === "toolCall" && state.retainedToolCallIds.has(block.id)) {
					retainedCallNames.set(block.id, block.name);
				}
			}
		} else if (message?.role === "toolResult" && state.retainedToolCallIds.has(message.toolCallId)) {
			retainedResultNames.set(message.toolCallId, message.toolName);
		}
	}
	const retainableToolCallIds = new Set(
		[...retainedCallNames].flatMap(([id, name]) => (retainedResultNames.get(id) === name ? [id] : [])),
	);

	const projected: ContextMessage[] = [];
	for (let index = 0; index < anchorIndex; index += 1) {
		const message = messages[index];
		if (!message) continue;
		if (message.role === "toolResult") {
			if (retainableToolCallIds.has(message.toolCallId)) projected.push(message);
			continue;
		}
		if (message.role !== "assistant") continue;
		const content = message.content.filter(
			(block) => block.type === "toolCall" && retainableToolCallIds.has(block.id),
		);
		if (content.length > 0) projected.push({ ...message, content });
	}
	projected.push(...messages.slice(anchorIndex));
	return projected;
}
