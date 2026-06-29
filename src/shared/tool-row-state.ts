import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { onTauEvent } from "./events.js";

export type ToolRowVisualState = "pruned";

type EventAPI = Pick<ExtensionAPI, "events">;

export interface ToolRowStateStore {
	get(toolCallId: string): ToolRowVisualState | undefined;
	watch(toolCallId: string, invalidate: () => void): void;
	clear(): void;
}

export function createToolRowStateStore(pi: EventAPI): ToolRowStateStore {
	const states = new Map<string, ToolRowVisualState>();
	const invalidators = new Map<string, () => void>();
	onTauEvent(pi, "tau:tool-row-state.set", ({ toolCallId, state }) => {
		if (state === undefined) states.delete(toolCallId);
		else states.set(toolCallId, state);
		invalidators.get(toolCallId)?.();
	});

	return {
		get(toolCallId) {
			return states.get(toolCallId);
		},
		watch(toolCallId, invalidate) {
			invalidators.set(toolCallId, invalidate);
		},
		clear() {
			states.clear();
			invalidators.clear();
		},
	};
}

export function formatToolRowTitle(
	store: ToolRowStateStore,
	toolCallId: string,
	toolName: string,
	theme: Theme,
): string {
	const color = store.get(toolCallId) === "pruned" ? "warning" : "toolTitle";
	return theme.fg(color, theme.bold(toolName));
}
