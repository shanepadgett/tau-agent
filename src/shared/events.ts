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
	"tau:autoread.requested": {
		source: string;
		title?: string;
		cwd: string;
		batchId: string;
		files: Array<{ path: string }>;
	};
	"tau:footer-item": {
		id: string;
		text?: string;
		priority?: number;
	};
	"tau:tool-row-state.set": {
		rowId: string;
		state?: ToolRowVisualState;
	};
};

export interface TauFooterItem {
	id: string;
	text?: string;
	priority?: number;
}

type EmitEventAPI = Pick<ExtensionAPI, "events">;

interface TauEventAPI extends EmitEventAPI {
	on(event: "session_start", handler: () => void): void;
	on(event: "session_shutdown", handler: () => void): void;
}

type TauEventHandler<Name extends keyof TauAgentEvents> = (data: TauAgentEvents[Name]) => void | Promise<void>;

interface TauEventSubscription {
	stop(): void;
}

const tauEventSubscriptions = new WeakMap<
	ExtensionAPI["events"],
	Map<string, Map<keyof TauAgentEvents, TauEventSubscription>>
>();

export function emitTauEvent<Name extends keyof TauAgentEvents>(
	pi: EmitEventAPI,
	name: Name,
	data: TauAgentEvents[Name],
): void {
	pi.events.emit(name, data);
}

export function onTauEvent<Name extends keyof TauAgentEvents>(
	pi: TauEventAPI,
	owner: string,
	name: Name,
	handler: TauEventHandler<Name>,
): () => void {
	if (owner.length === 0) throw new Error("Tau event owner is required.");

	const subscriptions = getOwnerSubscriptions(pi.events, owner);
	subscriptions.get(name)?.stop();

	let unsubscribe: (() => void) | undefined;
	let disposed = false;

	function detach(): void {
		unsubscribe?.();
		unsubscribe = undefined;
	}

	const subscription: TauEventSubscription = {
		stop() {
			if (disposed) return;
			disposed = true;
			detach();
			if (subscriptions.get(name) === subscription) subscriptions.delete(name);
		},
	};

	function attach(): void {
		if (disposed) return;
		detach();
		unsubscribe = pi.events.on(name, handler as (data: unknown) => void);
	}

	subscriptions.set(name, subscription);
	pi.on("session_start", attach);
	pi.on("session_shutdown", detach);
	return subscription.stop;
}

export function setTauFooterItem(pi: EmitEventAPI, item: TauFooterItem): void {
	emitTauEvent(pi, "tau:footer-item", item);
}

function getOwnerSubscriptions(
	events: ExtensionAPI["events"],
	owner: string,
): Map<keyof TauAgentEvents, TauEventSubscription> {
	let busSubscriptions = tauEventSubscriptions.get(events);
	if (!busSubscriptions) {
		busSubscriptions = new Map();
		tauEventSubscriptions.set(events, busSubscriptions);
	}

	let ownerSubscriptions = busSubscriptions.get(owner);
	if (!ownerSubscriptions) {
		ownerSubscriptions = new Map();
		busSubscriptions.set(owner, ownerSubscriptions);
	}

	return ownerSubscriptions;
}
