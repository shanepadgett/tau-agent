import { createEventBus, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { emitTauEvent, onTauEvent, type TauAgentEvents } from "../../src/shared/events.ts";

interface TestEventAPI extends Pick<ExtensionAPI, "events"> {
	on(event: "session_shutdown", handler: () => void): void;
	shutdown(): void;
}

function eventApi(): TestEventAPI {
	const shutdownHandlers: Array<() => void> = [];
	return {
		events: createEventBus(),
		on: (_event, handler) => {
			shutdownHandlers.push(handler);
		},
		shutdown: () => {
			for (const handler of shutdownHandlers) handler();
		},
	};
}

const payload = {
	source: "external-test",
	title: "External autoread test",
	cwd: "/tmp",
	batchId: "batch-1",
	files: [{ path: "README.md" }],
} satisfies TauAgentEvents["tau:autoread.requested"];

describe("Tau events", () => {
	it("delivers events sent through emitTauEvent", () => {
		const pi = eventApi();
		const received: TauAgentEvents["tau:autoread.requested"][] = [];
		onTauEvent(pi, "test.autoread", "tau:autoread.requested", (event) => {
			received.push(event);
		});

		emitTauEvent(pi, "tau:autoread.requested", payload);

		expect(received).toEqual([payload]);
	});

	it("delivers events sent directly through Pi events", () => {
		const pi = eventApi();
		const received: TauAgentEvents["tau:autoread.requested"][] = [];
		onTauEvent(pi, "test.autoread", "tau:autoread.requested", (event) => {
			received.push(event);
		});

		pi.events.emit("tau:autoread.requested", payload);

		expect(received).toEqual([payload]);
	});

	it("stops delivery after unsubscribe", () => {
		const pi = eventApi();
		let count = 0;
		const unsubscribe = onTauEvent(pi, "test.autoread", "tau:autoread.requested", () => {
			count += 1;
		});

		emitTauEvent(pi, "tau:autoread.requested", payload);
		unsubscribe();
		emitTauEvent(pi, "tau:autoread.requested", payload);

		expect(count).toBe(1);
	});

	it("replaces an existing owner registration", () => {
		const pi = eventApi();
		let firstCount = 0;
		let secondCount = 0;
		onTauEvent(pi, "test.autoread", "tau:autoread.requested", () => {
			firstCount += 1;
		});
		onTauEvent(pi, "test.autoread", "tau:autoread.requested", () => {
			secondCount += 1;
		});

		emitTauEvent(pi, "tau:autoread.requested", payload);

		expect(firstCount).toBe(0);
		expect(secondCount).toBe(1);
	});

	it("stops delivery on session shutdown", () => {
		const pi = eventApi();
		let count = 0;
		onTauEvent(pi, "test.autoread", "tau:autoread.requested", () => {
			count += 1;
		});

		pi.shutdown();
		emitTauEvent(pi, "tau:autoread.requested", payload);

		expect(count).toBe(0);
	});
});
