import type { ModelEffort } from "../../shared/model-effort.ts";

export const EFFORT_STATE_TYPE = "tau.model-effort.state";

export interface EffortStateV1 {
	v: 1;
	effort: ModelEffort | null;
}

export function effortState(effort: ModelEffort | undefined): EffortStateV1 {
	return { v: 1, effort: effort ?? null };
}

export function nextEffort(effort: ModelEffort | undefined): ModelEffort {
	if (effort === "quick") return "standard";
	if (effort === "standard") return "deep";
	return "quick";
}
