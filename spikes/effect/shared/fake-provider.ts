// Local fake Anthropic endpoint. Replays SSE in odd-sized byte chunks so both
// decoders must handle events split across reads.

const encoder = new TextEncoder();
const sse = (data: object) => `event: ${(data as { type: string }).type}\ndata: ${JSON.stringify(data)}\n\n`;

const head = [
	sse({ type: "message_start", message: { usage: { input_tokens: 12 } } }),
	sse({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
	"event: ping\ndata: {\"type\":\"ping\"}\n\n",
];
const delta = (text: string) => sse({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });
const tail = [
	sse({ type: "content_block_stop", index: 0 }),
	sse({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } }),
	sse({ type: "message_stop" }),
];

// Responses still streaming. Drops when a body finishes or the client disconnects.
export type Stats = { open: number };

export function startFakeProvider() {
	const stats: Stats = { open: 0 };
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		idleTimeout: 0,
		async fetch(request) {
			const mode = new URL(request.url).searchParams.get("mode") ?? "ok";
			await request.json();
			if (mode === "500") return Response.json({ type: "error", error: { message: "overloaded" } }, { status: 500 });
			stats.open++;
			let closed = false;
			const close = () => {
				if (!closed) stats.open--;
				closed = true;
			};
			request.signal.addEventListener("abort", close);
			const parts = (function* () {
				yield* head;
				if (mode === "forever") for (let i = 0; ; i++) yield delta(`tick ${i} `);
				if (mode === "bulk") for (let i = 0; i < 20_000; i++) yield delta("");
				for (const word of ["Hello", ", ", "world", "!"]) yield delta(word);
				if (mode !== "truncated") yield* tail;
			})();
			const body = new ReadableStream<Uint8Array>({
				async pull(controller) {
					const next = parts.next();
					if (next.done) {
						close();
						return controller.close();
					}
					const bytes = encoder.encode(next.value);
					for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.subarray(i, i + 7));
					if (mode !== "bulk") await Bun.sleep(5);
				},
				cancel: close,
			});
			return new Response(body, { headers: { "content-type": "text/event-stream" } });
		},
	});
	return { url: `http://127.0.0.1:${server.port}/v1/messages`, stats, stop: () => server.stop(true) };
}
