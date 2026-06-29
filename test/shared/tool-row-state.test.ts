import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { emitTauEvent } from "../../src/shared/events.ts";
import { createToolRowStateStore, formatToolRowTitle } from "../../src/shared/tool-row-state.ts";

const theme = {
	fg(name: string, text: string) {
		return `<${name}>${text}</${name}>`;
	},
	bold(text: string) {
		return `*${text}*`;
	},
} as unknown as Theme;

function eventApi(): Pick<ExtensionAPI, "events"> {
	return { events: { emit() {} } } as unknown as Pick<ExtensionAPI, "events">;
}

describe("tool row state", () => {
	it("colors normal and pruned titles without status words", async () => {
		const pi = eventApi();
		const store = createToolRowStateStore(pi);
		let invalidations = 0;
		store.watch("call-1", () => {
			invalidations += 1;
		});

		expect(formatToolRowTitle(store, "call-1", "grep", theme)).toBe("<toolTitle>*grep*</toolTitle>");
		await emitTauEvent(pi, "tau:tool-row-state.set", { toolCallId: "call-1", state: "pruned" });
		expect(invalidations).toBe(1);
		const title = formatToolRowTitle(store, "call-1", "grep", theme);
		expect(title).toBe("<warning>*grep*</warning>");
		expect(title).not.toContain("pruned");

		const result = { content: [{ type: "text", text: "saved result" }] };
		await emitTauEvent(pi, "tau:tool-row-state.set", { toolCallId: "call-1" });
		expect(result.content[0]?.text).toBe("saved result");
		expect(formatToolRowTitle(store, "call-1", "grep", theme)).toBe("<toolTitle>*grep*</toolTitle>");
	});
});
