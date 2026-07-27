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
		return messages.map((message, index) => annotate(message, refsByMessage[index] ?? []));
	}
	const anchorIndex = findAnchor(messages, state.latestAnchorToolCallId);
	if (anchorIndex < 0) return messages.map((message, index) => annotate(message, refsByMessage[index] ?? []));

	const retained = state.retainedRefs
		.flatMap((ref) => {
			const unit = catalog.get(ref);
			return unit ? [unit] : [];
		})
		.sort((left, right) => left.order - right.order || left.suborder - right.suborder);
	const projected: ContextMessage[] = [];
	for (const unit of retained) {
		for (let index = 0; index < unit.messages.length; index += 1) {
			projected.push(annotate(unit.messages[index] as ContextMessage, index === 0 ? [unit] : []));
		}
	}
	for (let index = anchorIndex; index < messages.length; index += 1) {
		const message = messages[index];
		if (!message) continue;
		projected.push(
			annotate(
				index === anchorIndex ? sanitizeAnchor(message, state.latestAnchorToolCallId) : message,
				refsByMessage[index] ?? [],
			),
		);
	}
	return projected;
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
	return generated.map(({ entry, message }, index) => {
		if (message.role === "assistant") {
			return [...catalog.values()].filter(
				(unit) =>
					(unit.ref === `m:${entry.id}` || unit.ref.startsWith(`t:${entry.id}:`)) &&
					messages[index]?.role === "assistant",
			);
		}
		const unit = catalog.get(`m:${entry.id}`);
		return unit ? [unit] : [];
	});
}

function annotate(message: ContextMessage, units: readonly MemoryUnit[]): ContextMessage {
	if (units.length === 0 || message.role === "toolResult") return message;
	const marker = `[wm ${units.map((unit) => `${unit.ref}${unit.label.startsWith("tool ") ? `=${unit.label.slice(5)}` : ""}`).join("; ")}]`;
	if (message.role === "assistant") {
		const firstTool = message.content.findIndex((block) => block.type === "toolCall");
		const index = firstTool < 0 ? message.content.length : firstTool;
		return {
			...message,
			content: [...message.content.slice(0, index), { type: "text", text: marker }, ...message.content.slice(index)],
		};
	}
	if (message.role === "user") {
		return {
			...message,
			content:
				typeof message.content === "string"
					? `${marker}\n${message.content}`
					: [{ type: "text", text: marker }, ...message.content],
		};
	}
	if (message.role === "custom") {
		return {
			...message,
			content:
				typeof message.content === "string"
					? `${marker}\n${message.content}`
					: [{ type: "text", text: marker }, ...message.content],
		};
	}
	if (message.role === "bashExecution") return { ...message, output: `${marker}\n${message.output}` };
	return { ...message, summary: `${marker}\n${message.summary}` };
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
