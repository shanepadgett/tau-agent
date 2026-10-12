import { end, initial, step, type SseEvent, type StreamEvent } from "../shared/anthropic.ts";

export async function* stream(url: string, body: object, signal?: AbortSignal): AsyncGenerator<StreamEvent> {
	const response = await fetch(url, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
		...(signal && { signal }),
	});
	if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
	let state = initial();
	for await (const sse of parseSse(response.body)) {
		const [next, events] = step(state, sse);
		state = next;
		yield* events;
	}
	yield* end(state);
}

async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) return;
			buffer += decoder.decode(value, { stream: true }).replaceAll("\r\n", "\n");
			for (let i = buffer.indexOf("\n\n"); i >= 0; i = buffer.indexOf("\n\n")) {
				const block = buffer.slice(0, i);
				buffer = buffer.slice(i + 2);
				let event: string | undefined;
				const data: string[] = [];
				for (const line of block.split("\n")) {
					if (line.startsWith("event:")) event = line.slice(6).trim();
					else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
				}
				if (data.length) yield { event, data: data.join("\n") };
			}
		}
	} finally {
		// Runs on early break or abort: closes the connection.
		await reader.cancel().catch(() => {});
	}
}
