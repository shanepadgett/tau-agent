import { createEventBus, type ExtensionAPI, type Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { emitTauEvent, onTauEvent } from "../../shared/events.ts";
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

function registerSnapshotProducer(pi: TestEventAPI, rows: string[]): void {
	const push = () => {
		emitTauEvent(pi, "tau:tool-row-state.snapshot", {
			states: rows.map((rowId) => ({ rowId, state: "pruned" as const })),
		});
	};
	onTauEvent(pi, "test.tool-row-state.producer", "tau:tool-row-state.snapshot.requested", push);
	pi.on("session_start", push);
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

	it("recovers when a producer pushes before the store listens", () => {
		const pi = eventApi();
		registerSnapshotProducer(pi, ["call-1"]);
		const store = createToolRowStateStore(pi, "test.tool-row-state");

		pi.start();

		expect(store.get("call-1")).toBe("pruned");
	});

	it("recovers when the store requests before the producer listens", () => {
		const pi = eventApi();
		const store = createToolRowStateStore(pi, "test.tool-row-state");
		registerSnapshotProducer(pi, ["call-1"]);

		pi.start();

		expect(store.get("call-1")).toBe("pruned");
	});

	it("replaces stale state and invalidates removed and added watched rows", () => {
		const pi = eventApi();
		const store = createToolRowStateStore(pi, "test.tool-row-state");
		pi.start();
		emitTauEvent(pi, "tau:tool-row-state.snapshot", {
			states: [
				{ rowId: "removed", state: "pruned" },
				{ rowId: "unchanged", state: "pruned" },
			],
		});
		const invalidated: string[] = [];
		for (const rowId of ["removed", "added", "unchanged"]) {
			store.watch(rowId, () => invalidated.push(rowId));
		}

		emitTauEvent(pi, "tau:tool-row-state.snapshot", {
			states: [
				{ rowId: "added", state: "pruned" },
				{ rowId: "unchanged", state: "pruned" },
			],
		});

		expect(store.get("removed")).toBeUndefined();
		expect(store.get("added")).toBe("pruned");
		expect(store.get("unchanged")).toBe("pruned");
		expect(invalidated).toEqual(["removed", "added"]);
	});
});
