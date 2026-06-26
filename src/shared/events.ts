import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

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
};

export interface TauFooterItem {
	id: string;
	text?: string;
	priority?: number;
}

type EventAPI = Pick<ExtensionAPI, "events">;
type TauEventHandler<Name extends keyof TauAgentEvents> = (data: TauAgentEvents[Name]) => void | Promise<void>;

const handlersByApi = new WeakMap<EventAPI, Map<keyof TauAgentEvents, Set<TauEventHandler<keyof TauAgentEvents>>>>();

export async function emitTauEvent<Name extends keyof TauAgentEvents>(
	pi: EventAPI,
	name: Name,
	data: TauAgentEvents[Name],
): Promise<void> {
	pi.events.emit(name, data);
	const handlers = handlersByApi.get(pi)?.get(name);
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
	let handlersByName = handlersByApi.get(pi);
	if (!handlersByName) {
		handlersByName = new Map();
		handlersByApi.set(pi, handlersByName);
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
