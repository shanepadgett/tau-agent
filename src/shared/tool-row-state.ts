import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { onTauEvent } from "./events.js";

export type ToolRowVisualState = "pruned";

interface EventAPI extends Pick<ExtensionAPI, "events"> {
	on(event: "session_start", handler: () => void): void;
	on(event: "session_shutdown", handler: () => void): void;
}

export interface ToolRowStateStore {
	get(rowId: string): ToolRowVisualState | undefined;
	watch(rowId: string, invalidate: () => void): void;
	clear(): void;
}

export function createToolRowStateStore(pi: EventAPI, owner: string): ToolRowStateStore {
	const states = new Map<string, ToolRowVisualState>();
	const invalidators = new Map<string, () => void>();
	onTauEvent(pi, owner, "tau:tool-row-state.set", ({ rowId, state }) => {
		if (state === undefined) states.delete(rowId);
		else states.set(rowId, state);
		invalidators.get(rowId)?.();
	});

	return {
		get(rowId) {
			return states.get(rowId);
		},
		watch(rowId, invalidate) {
			invalidators.set(rowId, invalidate);
		},
		clear() {
			states.clear();
			invalidators.clear();
		},
	};
}

export function formatToolRowTitle(store: ToolRowStateStore, rowId: string, toolName: string, theme: Theme): string {
	const color = store.get(rowId) === "pruned" ? "warning" : "toolTitle";
	return theme.fg(color, theme.bold(toolName));
}
