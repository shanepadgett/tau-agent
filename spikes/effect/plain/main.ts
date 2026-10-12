import type { StreamEvent } from "../shared/anthropic.ts";
import { assert, assertAllDead, assertComplete, assertDisconnected, assertTruncated, timed } from "../shared/checks.ts";
import { startFakeProvider } from "../shared/fake-provider.ts";
import { descendants, TREE_COMMANDS } from "../shared/ps.ts";
import { openSession } from "./session.ts";
import { stream } from "./stream.ts";

const provider = startFakeProvider();
const at = (mode: string) => `${provider.url}?mode=${mode}`;
const collect = async (iterable: AsyncIterable<StreamEvent>) => {
	const events: StreamEvent[] = [];
	for await (const event of iterable) events.push(event);
	return events;
};
const started = performance.now();

await timed("stream: complete message split across reads", async () => {
	assertComplete(await collect(stream(at("ok"), {})));
});
await timed("stream: truncated body ends with error event", async () => {
	assertTruncated(await collect(stream(at("truncated"), {})));
});
await timed("stream: HTTP 500 rejects", async () => {
	await assert.rejects(collect(stream(at("500"), {})), /HTTP 500/);
});
await timed("stream: consumer break closes connection", async () => {
	let count = 0;
	for await (const _ of stream(at("forever"), {})) if (++count === 3) break;
	await assertDisconnected(provider.stats, "break");
});
await timed("stream: abort signal rejects and closes connection", async () => {
	await assert.rejects(collect(stream(at("forever"), {}, AbortSignal.timeout(100))), { name: "TimeoutError" });
	await assertDisconnected(provider.stats, "abort");
});
await timed("stream: 20k deltas without delays", async () => {
	assertComplete(await collect(stream(at("bulk"), {})));
});

const bash = ["/bin/bash", "--noprofile", "--norc", "-i"];
await timed("session: scope exit kills job-control tree", async () => {
	let pids: number[];
	{
		await using session = openSession(bash);
		session.write(TREE_COMMANDS);
		await session.waitFor("TREE_READY");
		await Bun.sleep(100);
		pids = [session.pid, ...descendants(session.pid)];
	}
	await assertAllDead(pids, "scope exit");
});
await timed("session: abort mid-call kills tree before rejecting", async () => {
	let pids: number[] = [];
	const abort = new AbortController();
	const call = async () => {
		await using session = openSession(bash);
		session.write(TREE_COMMANDS);
		await session.waitFor("TREE_READY", abort.signal);
		await Bun.sleep(100);
		pids = [session.pid, ...descendants(session.pid)];
		setTimeout(() => abort.abort(), 50);
		await session.waitFor("NEVER", abort.signal);
	};
	await assert.rejects(call(), { name: "AbortError" });
	await assertAllDead(pids, "abort");
});

provider.stop();
console.log(`plain passed in ${(performance.now() - started).toFixed(0)} ms`);
