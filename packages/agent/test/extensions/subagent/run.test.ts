import { describe, expect, it } from "vitest";
import { FifoGate } from "../../../extensions/subagent/run.ts";

describe("subagent FIFO gate", () => {
	it("admits four calls and grants later calls in order", async () => {
		const gate = new FifoGate(4);
		const controllers = Array.from({ length: 6 }, () => new AbortController());
		const releases = await Promise.all(controllers.slice(0, 4).map((controller) => gate.acquire(controller.signal)));
		const order: number[] = [];
		const fifth = gate.acquire(controllers[4].signal).then((release) => {
			order.push(5);
			return release;
		});
		const sixth = gate.acquire(controllers[5].signal).then((release) => {
			order.push(6);
			return release;
		});

		releases[0]();
		const releaseFifth = await fifth;
		expect(order).toEqual([5]);
		releases[1]();
		const releaseSixth = await sixth;
		expect(order).toEqual([5, 6]);

		for (const release of [...releases.slice(2), releaseFifth, releaseSixth]) release();
	});

	it("removes an aborted waiter without consuming capacity", async () => {
		const gate = new FifoGate(1);
		const active = new AbortController();
		const release = await gate.acquire(active.signal);
		const waiting = new AbortController();
		const rejected = gate.acquire(waiting.signal);
		waiting.abort();
		await expect(rejected).rejects.toThrow("aborted while waiting");
		release();

		const nextRelease = await gate.acquire(new AbortController().signal);
		nextRelease();
	});
});
