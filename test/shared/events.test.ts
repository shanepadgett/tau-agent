import { createEventBus, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { emitTauEvent, onTauEvent, type TauAgentEvents } from "../../src/shared/events.ts";

function eventApi(): Pick<ExtensionAPI, "events"> {
	return { events: createEventBus() };
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
		onTauEvent(pi, "tau:autoread.requested", (event) => {
			received.push(event);
		});

		emitTauEvent(pi, "tau:autoread.requested", payload);

		expect(received).toEqual([payload]);
	});

	it("delivers events sent directly through Pi events", () => {
		const pi = eventApi();
		const received: TauAgentEvents["tau:autoread.requested"][] = [];
		onTauEvent(pi, "tau:autoread.requested", (event) => {
			received.push(event);
		});

		pi.events.emit("tau:autoread.requested", payload);

		expect(received).toEqual([payload]);
	});

	it("stops delivery after unsubscribe", () => {
		const pi = eventApi();
		let count = 0;
		const unsubscribe = onTauEvent(pi, "tau:autoread.requested", () => {
			count += 1;
		});

		emitTauEvent(pi, "tau:autoread.requested", payload);
		unsubscribe();
		emitTauEvent(pi, "tau:autoread.requested", payload);

		expect(count).toBe(1);
	});
});
