import { sessionEntryToContextMessages, type ContextEvent, type SessionEntry } from "@earendil-works/pi-coding-agent";
import type { ActiveWorkingMemoryState } from "./state.ts";

type ContextMessage = ContextEvent["messages"][number];

export interface MemoryUnit {
	ref: string;
	label: string;
	preview: string;
	order: number;
	suborder: number;
	messages: ContextMessage[];
	rowIds: string[];
}

const EXCLUDED_CUSTOM_TYPES = new Set(["tau.autoread", "tau.runtime-context", "tau.working-memory.nudge"]);
const REFERENCE_CATALOG_TYPE = "tau.working-memory.references";

export function buildMemoryCatalog(branch: readonly SessionEntry[]): Map<string, MemoryUnit> {
	const catalog = new Map<string, MemoryUnit>();
	const results = new Map<string, ContextMessage>();
	for (const entry of branch) {
		for (const message of sessionEntryToContextMessages(entry)) {
			if (message.role === "toolResult") results.set(message.toolCallId, message);
		}
	}

	for (let order = 0; order < branch.length; order += 1) {
		const entry = branch[order];
		if (!entry) continue;
		const message = sessionEntryToContextMessages(entry)[0];
		if (!message) continue;
		if (message.role === "assistant") {
			const calls = message.content.filter((block) => block.type === "toolCall");
			const frameworkCall = calls.some((call) => call.name === "working_memory");
			if (frameworkCall) continue;
			const prose = message.content.filter((block) => block.type !== "toolCall");
			if (prose.length > 0) {
				const ref = `m:${entry.id}`;
				catalog.set(ref, {
					ref,
					label: "assistant",
					preview: previewAssistant(prose),
					order,
					suborder: 0,
					messages: [{ ...message, content: prose }],
					rowIds: [],
				});
			}
			for (let index = 0; index < calls.length; index += 1) {
				const call = calls[index];
				if (!call) continue;
				const result = results.get(call.id);
				if (result?.role !== "toolResult" || result.toolName !== call.name) continue;
				const ref = `t:${entry.id}:${index + 1}`;
				catalog.set(ref, {
					ref,
					label: `tool ${call.name}`,
					preview: previewTool(call.arguments),
					order,
					suborder: index + 1,
					messages: [{ ...message, content: [call] }, result],
					rowIds: [call.id],
				});
			}
			continue;
		}
		if (message.role === "toolResult") continue;
		if (message.role === "custom" && EXCLUDED_CUSTOM_TYPES.has(message.customType)) continue;
		const ref = `m:${entry.id}`;
		catalog.set(ref, {
			ref,
			label: message.role === "custom" ? message.customType : message.role,
			preview: previewMessage(message),
			order,
			suborder: 0,
			messages: [message],
			rowIds: outlineRowIds(message),
		});
	}
	return catalog;
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
		.sort((left, right) => left.order - right.order || left.suborder - right.suborder);
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
	const generated = entries.flatMap((entry) =>
		sessionEntryToContextMessages(entry).map((message) => ({ entry, message })),
	);
	if (generated.length !== messages.length) return messages.map(() => []);
	const toolRefs = new Map<string, MemoryUnit[]>();
	for (const unit of catalog.values()) {
		const result = unit.messages.find((message) => message.role === "toolResult");
		if (result?.role !== "toolResult") continue;
		toolRefs.set(result.toolCallId, [...(toolRefs.get(result.toolCallId) ?? []), unit]);
	}
	return generated.map(({ entry, message }, index) => {
		if (message.role === "assistant") {
			const unit = catalog.get(`m:${entry.id}`);
			return unit && messages[index]?.role === "assistant" ? [unit] : [];
		}
		if (message.role === "toolResult") return toolRefs.get(message.toolCallId) ?? [];
		const unit = catalog.get(`m:${entry.id}`);
		return unit ? [unit] : [];
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
				.sort((left, right) => left.order - right.order || left.suborder - right.suborder)
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
		if (block.type === "thinking" && "thinking" in block && typeof block.thinking === "string") {
			return compact(block.thinking);
		}
	}
	return "";
}

function previewTool(args: Record<string, unknown>): string {
	return compact(JSON.stringify(args));
}

function previewMessage(message: ContextMessage): string {
	if (message.role === "user" || message.role === "custom") {
		if (typeof message.content === "string") return compact(message.content);
		const text = message.content.find((part) => part.type === "text");
		return text?.type === "text" ? compact(text.text) : "";
	}
	if (message.role === "bashExecution") return compact(`${message.command}: ${message.output}`);
	if (message.role === "assistant") return previewAssistant(message.content);
	if (message.role === "toolResult") {
		const text = message.content.find((part) => part.type === "text");
		return text?.type === "text" ? compact(text.text) : "";
	}
	return compact(message.summary);
}

function outlineRowIds(message: ContextMessage): string[] {
	if (message.role !== "custom" || message.customType !== "tau.explore.outline") return [];
	if (!isRecord(message.details) || typeof message.details.rowId !== "string") return [];
	return [message.details.rowId];
}

function compact(value: string): string {
	const text = value.replaceAll(/\s+/g, " ").trim();
	return text.length <= 120 ? text : `${text.slice(0, 119)}…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
