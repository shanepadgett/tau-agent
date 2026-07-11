import { createEventBus, type ExtensionAPI, type Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { emitTauEvent } from "../../shared/events.ts";
import { createToolRowStateStore, formatToolRowTitle } from "../../shared/tool-row-state.ts";

const theme = {
	fg(name: string, text: string) {
		return `<${name}>${text}</${name}>`;
	},
	bold(text: string) {
		return `*${text}*`;
	},
} as unknown as Theme;

interface TestEventAPI extends Pick<ExtensionAPI, "events"> {
	on(event: "session_start", handler: () => void): void;
	on(event: "session_shutdown", handler: () => void): void;
	start(): void;
}

function eventApi(): TestEventAPI {
	const startHandlers: Array<() => void> = [];
	return {
		events: createEventBus(),
		on: (event: "session_start" | "session_shutdown", handler: () => void) => {
			if (event === "session_start") startHandlers.push(handler);
		},
		start: () => {
			for (const handler of startHandlers) handler();
		},
	};
}

describe("tool row state", () => {
	it("colors normal and pruned titles without status words", async () => {
		const pi = eventApi();
		const store = createToolRowStateStore(pi, "test.tool-row-state");
		pi.start();
		let invalidations = 0;
		store.watch("call-1", () => {
			invalidations += 1;
		});

		expect(formatToolRowTitle(store, "call-1", "grep", theme)).toBe("<toolTitle>*grep*</toolTitle>");
		emitTauEvent(pi, "tau:tool-row-state.set", { rowId: "call-1", state: "pruned" });
		expect(invalidations).toBe(1);
		const title = formatToolRowTitle(store, "call-1", "grep", theme);
		expect(title).toBe("<warning>*grep*</warning>");
		expect(title).not.toContain("pruned");

		const result = { content: [{ type: "text", text: "saved result" }] };
		emitTauEvent(pi, "tau:tool-row-state.set", { rowId: "call-1" });
		expect(result.content[0]?.text).toBe("saved result");
		expect(formatToolRowTitle(store, "call-1", "grep", theme)).toBe("<toolTitle>*grep*</toolTitle>");
	});
});
