import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type TauAgentEvents = {
	"tau:agent.blocked": {
		title?: string;
		body?: string;
		source?: string;
	};
	"tau:footer-item": {
		id: string;
		text?: string;
		priority?: number;
	};
	"tau:posture.continuation_queued": {
		posture: string;
	};
};

export interface TauFooterItem {
	id: string;
	text?: string;
	priority?: number;
}

type EventAPI = Pick<ExtensionAPI, "events">;

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
	handler: (data: TauAgentEvents[Name]) => void,
): () => void {
	return pi.events.on(name, (data) => {
		handler(data as TauAgentEvents[Name]);
	});
}

export function setTauFooterItem(pi: EventAPI, item: TauFooterItem): void {
	emitTauEvent(pi, "tau:footer-item", item);
}
