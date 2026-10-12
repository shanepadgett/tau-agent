import { strict as assert } from "node:assert";
import type { StreamEvent } from "./anthropic.ts";
import type { Stats } from "./fake-provider.ts";
import { alive } from "./ps.ts";

export { assert };

export function assertComplete(events: ReadonlyArray<StreamEvent>) {
	const text = events.flatMap((e) => (e.type === "text" ? [e.text] : [])).join("");
	assert.equal(text, "Hello, world!");
	assert.deepEqual(events.at(-1), { type: "done", stop: "end_turn", usage: { input: 12, output: 5 } });
}

export function assertTruncated(events: ReadonlyArray<StreamEvent>) {
	assert.deepEqual(events.at(-1), { type: "error", message: "stream ended before message_stop" });
}

// The server must see the client disconnect after a cancel or early stop.
export async function assertDisconnected(stats: Stats, label: string) {
	const end = performance.now() + 1000;
	while (stats.open > 0) {
		if (performance.now() > end) throw new Error(`${label}: server connection still open`);
		await Bun.sleep(10);
	}
}

// Killed children can linger briefly as zombies until reparented and reaped.
export async function assertAllDead(pids: number[], label: string) {
	assert.ok(pids.length >= 3, `${label}: expected a process tree, got ${pids}`);
	const end = performance.now() + 1000;
	while (pids.some(alive)) {
		if (performance.now() > end) throw new Error(`${label}: survivors ${pids.filter(alive)}`);
		await Bun.sleep(10);
	}
}

export async function timed(label: string, run: () => Promise<void>) {
	const start = performance.now();
	await run();
	console.log(`ok ${label} (${(performance.now() - start).toFixed(0)} ms)`);
}
