import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ToolRowVisualState } from "./tool-row-state.js";

export type TauAgentEvents = {
	"tau:agent.blocked": {
		title?: string;
		body?: string;
		source?: string;
	};
	"tau:file-mutation.applied": {
		source: "patch";
		toolCallId: string;
		cwd: string;
		status: "completed" | "partial" | "failed";
		changes: Array<{
			path: string;
			kind: "add" | "replace" | "update" | "delete";
			move?: { from: string; to: string };
			linesAdded: number;
			linesRemoved: number;
			snapshotRanges?: Array<{ startLine: number; endLine: number }>;
		}>;
	};
	"tau:context.snapshot": {
		source: "tau-edit";
		title?: string;
		cwd: string;
		batchId: string;
		deliverAs?: "steer" | "followUp" | "nextTurn";
		files: Array<{ path: string; content: string }>;
	};
	"tau:footer-item": {
		id: string;
		text?: string;
		priority?: number;
	};
	"tau:tool-row-state.set": {
		toolCallId: string;
		state?: ToolRowVisualState;
	};
};

export interface TauFooterItem {
	id: string;
	text?: string;
	priority?: number;
}

type EventAPI = Pick<ExtensionAPI, "events">;
type TauEventHandler<Name extends keyof TauAgentEvents> = (data: TauAgentEvents[Name]) => void | Promise<void>;
type HandlerStore = WeakMap<EventAPI["events"], Map<keyof TauAgentEvents, Set<TauEventHandler<keyof TauAgentEvents>>>>;
type TauEventGlobal = typeof globalThis & { __tauAgentEventHandlers?: HandlerStore };

const tauEventGlobal = globalThis as TauEventGlobal;
if (!tauEventGlobal.__tauAgentEventHandlers) tauEventGlobal.__tauAgentEventHandlers = new WeakMap();
const handlersByBus: HandlerStore = tauEventGlobal.__tauAgentEventHandlers;

export async function emitTauEvent<Name extends keyof TauAgentEvents>(
	pi: EventAPI,
	name: Name,
	data: TauAgentEvents[Name],
): Promise<void> {
	pi.events.emit(name, data);
	const handlers = handlersByBus.get(pi.events)?.get(name);
	if (!handlers) return;
	await Promise.all(
		[...handlers].map(async (handler) => {
			try {
				await handler(data);
			} catch (error) {
				console.error(`Event handler error (${name}):`, error);
			}
		}),
	);
}

export function onTauEvent<Name extends keyof TauAgentEvents>(
	pi: EventAPI,
	name: Name,
	handler: TauEventHandler<Name>,
): () => void {
	let handlersByName = handlersByBus.get(pi.events);
	if (!handlersByName) {
		handlersByName = new Map();
		handlersByBus.set(pi.events, handlersByName);
	}
	let handlers = handlersByName.get(name);
	if (!handlers) {
		handlers = new Set();
		handlersByName.set(name, handlers);
	}
	const storedHandler = handler as TauEventHandler<keyof TauAgentEvents>;
	handlers.add(storedHandler);
	return () => {
		handlers?.delete(storedHandler);
		if (handlers?.size === 0) handlersByName.delete(name);
	};
}

export function setTauFooterItem(pi: EventAPI, item: TauFooterItem): void {
	void emitTauEvent(pi, "tau:footer-item", item);
}
