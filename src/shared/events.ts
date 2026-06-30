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

type EventAPI = Pick<ExtensionAPI, "events">;
type TauEventHandler<Name extends keyof TauAgentEvents> = (data: TauAgentEvents[Name]) => void | Promise<void>;

export function emitTauEvent<Name extends keyof TauAgentEvents>(
	pi: EventAPI,
	name: Name,
	data: TauAgentEvents[Name],
): void {
	pi.events.emit(name, data);
}

export function onTauEvent<Name extends keyof TauAgentEvents>(
	pi: EventAPI,
	name: Name,
	handler: TauEventHandler<Name>,
): () => void {
	return pi.events.on(name, handler as (data: unknown) => void);
}

export function setTauFooterItem(pi: EventAPI, item: TauFooterItem): void {
	emitTauEvent(pi, "tau:footer-item", item);
}
