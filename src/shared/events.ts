import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type TauAgentEvents = {
	"tau:attention": {
		title?: string;
		body?: string;
	};
};

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
