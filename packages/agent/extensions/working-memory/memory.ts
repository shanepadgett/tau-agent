import { sessionEntryToContextMessages, type ContextEvent, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { isContextProjectionMessage, isLegacyContextMessage } from "../../shared/context-messages.ts";
import type { ActiveWorkingMemoryState } from "./state.ts";

type ContextMessage = ContextEvent["messages"][number];

export interface MemoryUnit {
	ref: string;
	label: string;
	preview: string;
	order: number;
	messages: ContextMessage[];
}

const REFERENCE_CATALOG_TYPE = "tau.working-memory.references";

export function buildMemoryCatalog(branch: readonly SessionEntry[]): Map<string, MemoryUnit> {
	const catalog = new Map<string, MemoryUnit>();
	for (let order = 0; order < branch.length; order += 1) {
		const entry = branch[order];
		if (!entry) continue;
		const message = sessionEntryToContextMessages(entry)[0];
		if (!message) continue;
		if (message.role === "assistant") {
			const calls = message.content.filter((block) => block.type === "toolCall");
			const frameworkCall = calls.some((call) => call.name === "working_memory");
			if (frameworkCall) continue;
			const text = message.content.filter((block) => block.type === "text");
			if (text.length > 0) {
				const ref = `m:${entry.id}`;
				catalog.set(ref, {
					ref,
					label: "assistant",
					preview: previewAssistant(text),
					order,
					messages: [{ ...message, content: text }],
				});
			}
			continue;
		}
		if (message.role !== "user") continue;
		const ref = `m:${entry.id}`;
		catalog.set(ref, {
			ref,
			label: "user",
			preview: previewUser(message),
			order,
			messages: [message],
		});
	}
	return catalog;
}

export function collectPrunedRowIds(branch: readonly SessionEntry[], before: number): string[] {
	const rowIds = new Set<string>();
	for (let index = 0; index < before; index += 1) {
		const entry = branch[index];
		if (!entry) continue;
		for (const message of sessionEntryToContextMessages(entry)) {
			if (message.role === "assistant") {
				for (const block of message.content) {
					if (block.type === "toolCall" && block.name !== "working_memory") rowIds.add(block.id);
				}
			}
			if (
				message.role === "custom" &&
				message.customType === "tau.explore.outline" &&
				isRecord(message.details) &&
				typeof message.details.rowId === "string"
			) {
				rowIds.add(message.details.rowId);
			}
		}
	}
	return [...rowIds];
}

export function projectWorkingMemory(
	messages: readonly ContextMessage[],
	state: ActiveWorkingMemoryState,
	branch: readonly SessionEntry[],
	contextEntries: readonly SessionEntry[],
): ContextMessage[] {
	const catalog = buildMemoryCatalog(branch);
	const refsByMessage = referenceCurrentMessages(messages, contextEntries, catalog);
	if (state.latestAnchorToolCallId === undefined) {
		return addReferenceCatalog(messages, refsByMessage);
	}
	const anchorIndex = findAnchor(messages, state.latestAnchorToolCallId);
	if (anchorIndex < 0) return addReferenceCatalog(messages, refsByMessage);

	const retained = state.retainedRefs
		.flatMap((ref) => {
			const unit = catalog.get(ref);
			return unit ? [unit] : [];
		})
		.sort((left, right) => left.order - right.order);
	const projected: ContextMessage[] = [];
	const projectedRefs: MemoryUnit[][] = [];
	for (const unit of retained) {
		projected.push(...unit.messages);
		projectedRefs.push(...unit.messages.map((_, index) => (index === unit.messages.length - 1 ? [unit] : [])));
	}
	for (let index = anchorIndex; index < messages.length; index += 1) {
		const message = messages[index];
		if (!message) continue;
		projected.push(index === anchorIndex ? sanitizeAnchor(message, state.latestAnchorToolCallId) : message);
		projectedRefs.push(refsByMessage[index] ?? []);
	}
	return addReferenceCatalog(projected, projectedRefs);
}

function referenceCurrentMessages(
	messages: readonly ContextMessage[],
	entries: readonly SessionEntry[],
	catalog: ReadonlyMap<string, MemoryUnit>,
): MemoryUnit[][] {
	const generated = entries
		.flatMap((entry) => sessionEntryToContextMessages(entry).map((message) => ({ entry, message })))
		.filter(({ message }) => !isLegacyContextMessage(message));
	const sessionMessages = messages.filter(
		(message) => !isContextProjectionMessage(message) && !isLegacyContextMessage(message),
	);
	if (generated.length !== sessionMessages.length) return messages.map(() => []);
	let generatedIndex = 0;
	return messages.map((currentMessage) => {
		if (isContextProjectionMessage(currentMessage) || isLegacyContextMessage(currentMessage)) return [];
		const current = generated[generatedIndex];
		generatedIndex += 1;
		if (!current) return [];
		const { entry, message } = current;
		if (message.role !== "user" && message.role !== "assistant") return [];
		const unit = catalog.get(`m:${entry.id}`);
		return unit && currentMessage.role === message.role ? [unit] : [];
	});
}

function addReferenceCatalog(
	messages: readonly ContextMessage[],
	unitsByMessage: readonly MemoryUnit[][],
): ContextMessage[] {
	const projected: ContextMessage[] = [
		{
			role: "custom",
			customType: REFERENCE_CATALOG_TYPE,
			content:
				"Working-memory references follow their source messages. Use these exact refs in working_memory.keep; do not repeat them in responses.",
			display: false,
			timestamp: 0,
		},
	];
	for (let index = 0; index < messages.length; index += 1) {
		const message = messages[index];
		if (!message) continue;
		projected.push(message);
		const unique = new Map((unitsByMessage[index] ?? []).map((unit) => [unit.ref, unit]));
		if (unique.size === 0) continue;
		projected.push({
			role: "custom",
			customType: REFERENCE_CATALOG_TYPE,
			content: [...unique.values()]
				.sort((left, right) => left.order - right.order)
				.map((unit) => `${unit.ref} (${unit.label}): ${unit.preview}`)
				.join("\n"),
			display: false,
			timestamp: 0,
		});
	}
	return projected;
}

function sanitizeAnchor(message: ContextMessage, id: string): ContextMessage {
	if (message.role !== "assistant") return message;
	return {
		...message,
		content: message.content.map((block) =>
			block.type === "toolCall" && block.id === id && block.name === "working_memory"
				? { ...block, arguments: { checkpoint: true } }
				: block,
		),
	};
}

function findAnchor(messages: readonly ContextMessage[], id: string): number {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (
			message?.role === "assistant" &&
			message.content.some(
				(block) => block.type === "toolCall" && block.id === id && block.name === "working_memory",
			)
		) {
			return index;
		}
	}
	return -1;
}

function previewAssistant(blocks: ReadonlyArray<{ type: string }>): string {
	for (const block of blocks) {
		if (block.type === "text" && "text" in block && typeof block.text === "string") return compact(block.text);
	}
	return "";
}

function previewUser(message: Extract<ContextMessage, { role: "user" }>): string {
	if (typeof message.content === "string") return compact(message.content);
	const text = message.content.find((part) => part.type === "text");
	return text?.type === "text" ? compact(text.text) : "";
}

function compact(value: string): string {
	const text = value.replaceAll(/\s+/g, " ").trim();
	return text.length <= 120 ? text : `${text.slice(0, 119)}…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
