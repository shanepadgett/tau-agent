import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { emitTauEvent } from "./events.ts";

export interface AgentBlockedNotice {
	title?: string;
	body?: string;
	source?: string;
}

export function emitAgentBlocked(pi: Pick<ExtensionAPI, "events">, notice: AgentBlockedNotice = {}): void {
	emitTauEvent(pi, "tau:agent.blocked", notice);
}
