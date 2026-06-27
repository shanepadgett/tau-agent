import type { Theme } from "@earendil-works/pi-coding-agent";

export type EvidenceStatus = "outdated" | "forgotten" | "irrelevant";

export interface SearchRenderState {
	statuses: Map<string, EvidenceStatus>;
	setStatuses(statuses: Map<string, EvidenceStatus>): void;
}

export function createSearchRenderState(): SearchRenderState {
	return {
		statuses: new Map(),
		setStatuses(statuses) {
			this.statuses = statuses;
		},
	};
}

export function toolHeader(theme: Theme, name: string): string {
	return theme.fg("toolTitle", theme.bold(name));
}

export function formatStatus(theme: Theme, state: SearchRenderState, toolCallId: string): string {
	const status = state.statuses.get(toolCallId);
	return status ? ` ${theme.fg("muted", `[${status}]`)}` : "";
}
