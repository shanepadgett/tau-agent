import { Effect, Stream } from "effect";
import { FetchHttpClient } from "effect/http";
import type { StreamEvent } from "../shared/anthropic.ts";
import { assert, assertAllDead, assertComplete, assertDisconnected, assertTruncated, timed } from "../shared/checks.ts";
import { startFakeProvider } from "../shared/fake-provider.ts";
import { descendants, TREE_COMMANDS } from "../shared/ps.ts";
import { openSession, waitFor } from "./session.ts";
import { stream } from "./stream.ts";

const provider = startFakeProvider();
const at = (mode: string) => `${provider.url}?mode=${mode}`;
const run = <A, E>(effect: Effect.Effect<A, E, never>, signal?: AbortSignal) =>
	Effect.runPromise(effect, signal && { signal });
const collect = (mode: string) => stream(at(mode), {}).pipe(Stream.runCollect, Effect.provide(FetchHttpClient.layer));
const started = performance.now();

await timed("stream: complete message split across reads", async () => {
	assertComplete(await run(collect("ok")));
});
await timed("stream: truncated body ends with error event", async () => {
	assertTruncated(await run(collect("truncated")));
});
await timed("stream: HTTP 500 rejects", async () => {
	await assert.rejects(run(collect("500")), (error: unknown) => {
		console.log("  500 error:", String(error).split("\n")[0]);
		return true;
	});
});
await timed("stream: Stream.take closes connection", async () => {
	const events = await run(
		stream(at("forever"), {}).pipe(Stream.take(3), Stream.runCollect, Effect.provide(FetchHttpClient.layer)),
	);
	assert.equal(events.length, 3);
	await assertDisconnected(provider.stats, "take");
});
await timed("stream: Effect.timeout interrupts and closes connection", async () => {
	await assert.rejects(run(collect("forever").pipe(Effect.timeout("100 millis"))));
	await assertDisconnected(provider.stats, "timeout");
});
await timed("stream: AsyncIterable facade break closes connection", async () => {
	const iterable: AsyncIterable<StreamEvent> = Stream.toAsyncIterable(
		stream(at("forever"), {}).pipe(Stream.provide(FetchHttpClient.layer)),
	);
	let count = 0;
	for await (const _ of iterable) if (++count === 3) break;
	await assertDisconnected(provider.stats, "facade break");
});
await timed("stream: runPromise AbortSignal rejects and closes connection", async () => {
	await assert.rejects(run(collect("forever"), AbortSignal.timeout(100)));
	await assertDisconnected(provider.stats, "facade abort");
});
await timed("stream: 20k deltas without delays", async () => {
	assertComplete(await run(collect("bulk")));
});

const bash = ["/bin/bash", "--noprofile", "--norc", "-i"];
const startTree = Effect.gen(function* () {
	const handle = yield* openSession(bash);
	handle.terminal.write(TREE_COMMANDS);
	yield* waitFor(handle, "TREE_READY");
	yield* Effect.sleep("100 millis");
	return { handle, pids: [handle.proc.pid, ...descendants(handle.proc.pid)] };
});

await timed("session: scope exit kills job-control tree", async () => {
	const pids = await run(Effect.scoped(startTree.pipe(Effect.map(({ pids }) => pids))));
	await assertAllDead(pids, "scope exit");
});
await timed("session: abort mid-call kills tree before rejecting", async () => {
	let pids: number[] = [];
	const abort = new AbortController();
	const call = Effect.scoped(
		Effect.gen(function* () {
			const tree = yield* startTree;
			pids = tree.pids;
			setTimeout(() => abort.abort(), 50);
			yield* waitFor(tree.handle, "NEVER");
		}),
	);
	await assert.rejects(run(call, abort.signal));
	await assertAllDead(pids, "abort");
});

provider.stop();
console.log(`effect passed in ${(performance.now() - started).toFixed(0)} ms`);
