import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export const CONTEXT_SELECTION_TYPE = "tau.context.selection";

export interface ContextSelectionStateV1 {
	v: 1;
	entryIds: string[];
}

export function createContextSelectionState(entryIds: readonly string[]): ContextSelectionStateV1 {
	return { v: 1, entryIds: [...new Set(entryIds)].sort((left, right) => left.localeCompare(right)) };
}

export function replayContextSelection(branch: readonly SessionEntry[]): ContextSelectionStateV1 {
	for (let index = branch.length - 1; index >= 0; index -= 1) {
		const entry = branch[index];
		if (entry?.type !== "custom" || entry.customType !== CONTEXT_SELECTION_TYPE) continue;
		const state = parseContextSelectionState(entry.data);
		if (state) return state;
	}
	return createContextSelectionState([]);
}

function parseContextSelectionState(value: unknown): ContextSelectionStateV1 | undefined {
	if (!value || typeof value !== "object") return undefined;
	const record = value as Record<string, unknown>;
	if (record.v !== 1 || !Array.isArray(record.entryIds) || record.entryIds.some((id) => typeof id !== "string"))
		return undefined;
	return createContextSelectionState(record.entryIds as string[]);
}
