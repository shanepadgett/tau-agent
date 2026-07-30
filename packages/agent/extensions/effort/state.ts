import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { ModelEffort } from "../../shared/model-effort.ts";

export const EFFORT_STATE_TYPE = "tau.model-effort.state";

export interface EffortStateV1 {
	v: 1;
	effort: ModelEffort | null;
}

export function effortState(effort: ModelEffort | undefined): EffortStateV1 {
	return { v: 1, effort: effort ?? null };
}

export function replayEffortState(branch: readonly SessionEntry[]): ModelEffort | undefined {
	for (let index = branch.length - 1; index >= 0; index -= 1) {
		const entry = branch[index];
		if (entry?.type !== "custom" || entry.customType !== EFFORT_STATE_TYPE) continue;
		const data = entry.data;
		if (!data || typeof data !== "object") continue;
		const value = data as Record<string, unknown>;
		if (value.v !== 1) continue;
		if (value.effort === null) return undefined;
		if (value.effort === "quick" || value.effort === "standard" || value.effort === "deep") return value.effort;
	}
	return undefined;
}

export function nextEffort(effort: ModelEffort | undefined): ModelEffort {
	if (effort === "quick") return "standard";
	if (effort === "standard") return "deep";
	return "quick";
}
