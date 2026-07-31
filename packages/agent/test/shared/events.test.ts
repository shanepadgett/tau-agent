import { createEventBus, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { emitTauEvent, onTauEvent, type TauAgentEvents } from "../../shared/events.ts";

interface TestEventAPI extends Pick<ExtensionAPI, "events"> {
	on(event: "session_start", handler: () => void): void;
	on(event: "session_shutdown", handler: () => void): void;
	start(): void;
	shutdown(): void;
}

function eventApi(): TestEventAPI {
	const startHandlers: Array<() => void> = [];
	const shutdownHandlers: Array<() => void> = [];
	return {
		events: createEventBus(),
		on: (event: "session_start" | "session_shutdown", handler: () => void) => {
			if (event === "session_start") startHandlers.push(handler);
			else shutdownHandlers.push(handler);
		},
		start: () => {
			for (const handler of startHandlers) handler();
		},
		shutdown: () => {
			for (const handler of shutdownHandlers) handler();
		},
	};
}

const payload = {
	source: "external-test",
	title: "External event test",
	body: "External event body",
} satisfies TauAgentEvents["tau:agent.blocked"];

describe("Tau events", () => {
	it("delivers events sent through emitTauEvent", () => {
		const pi = eventApi();
		const received: TauAgentEvents["tau:agent.blocked"][] = [];
		onTauEvent(pi, "test.blocked", "tau:agent.blocked", (event) => {
			received.push(event);
		});
		pi.start();

		emitTauEvent(pi, "tau:agent.blocked", payload);

		expect(received).toEqual([payload]);
	});

	it("delivers events sent directly through Pi events", () => {
		const pi = eventApi();
		const received: TauAgentEvents["tau:agent.blocked"][] = [];
		onTauEvent(pi, "test.blocked", "tau:agent.blocked", (event) => {
			received.push(event);
		});
		pi.start();

		pi.events.emit("tau:agent.blocked", payload);

		expect(received).toEqual([payload]);
	});

	it("stops delivery after unsubscribe", () => {
		const pi = eventApi();
		let count = 0;
		const unsubscribe = onTauEvent(pi, "test.blocked", "tau:agent.blocked", () => {
			count += 1;
		});
		pi.start();

		emitTauEvent(pi, "tau:agent.blocked", payload);
		unsubscribe();
		emitTauEvent(pi, "tau:agent.blocked", payload);

		expect(count).toBe(1);
	});

	it("replaces an existing owner registration", () => {
		const pi = eventApi();
		let firstCount = 0;
		let secondCount = 0;
		onTauEvent(pi, "test.blocked", "tau:agent.blocked", () => {
			firstCount += 1;
		});
		onTauEvent(pi, "test.blocked", "tau:agent.blocked", () => {
			secondCount += 1;
		});
		pi.start();

		emitTauEvent(pi, "tau:agent.blocked", payload);

		expect(firstCount).toBe(0);
		expect(secondCount).toBe(1);
	});

	it("stops delivery on session shutdown", () => {
		const pi = eventApi();
		let count = 0;
		onTauEvent(pi, "test.blocked", "tau:agent.blocked", () => {
			count += 1;
		});
		pi.start();

		pi.shutdown();
		emitTauEvent(pi, "tau:agent.blocked", payload);

		expect(count).toBe(0);
	});
});
