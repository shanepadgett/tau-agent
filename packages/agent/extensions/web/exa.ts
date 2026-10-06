import { setTimeout as delay } from "node:timers/promises";
import { searchObject, type SearchAdapter, type SearchRequest, type SearchResult } from "./search-types.ts";

const EXA_ENDPOINT = "https://mcp.exa.ai/mcp";
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const SEARCH_START_INTERVAL_MS = 2000;

function extractText(payload: unknown): string | undefined {
	const root = searchObject(payload);
	if (!root) return undefined;
	if (searchObject(root.error)) throw new Error("Exa JSON-RPC request failed");

	const result = searchObject(root.result);
	if (!result || !Array.isArray(result.content)) return undefined;
	if (result.isError === true) throw new Error("Exa search tool failed");
	const text = result.content
		.map((item) => searchObject(item))
		.filter((item): item is Record<string, unknown> => item !== undefined)
		.filter((item) => item.type === "text" && typeof item.text === "string")
		.map((item) => item.text as string)
		.join("\n");
	return text.length > 0 ? text : "No search results found. Try a more specific query.";
}

function parseSse(raw: string): string | undefined {
	for (const event of raw.split(/\r?\n\r?\n/)) {
		const data = event
			.split(/\r?\n/)
			.filter((line) => line.startsWith("data:"))
			.map((line) => line.slice(5).replace(/^ /, ""))
			.join("\n");
		if (!data || data === "[DONE]") continue;
		try {
			const text = extractText(JSON.parse(data) as unknown);
			if (text !== undefined) return text;
		} catch (error) {
			if (error instanceof SyntaxError) continue;
			throw error;
		}
	}
	return undefined;
}

async function callExa(request: SearchRequest, signal: AbortSignal): Promise<string | undefined> {
	const headers: Record<string, string> = {
		accept: "application/json, text/event-stream",
		"content-type": "application/json",
	};
	const apiKey = process.env.EXA_API_KEY?.trim();
	if (apiKey) headers["x-api-key"] = apiKey;
	const response = await fetch(EXA_ENDPOINT, {
		method: "POST",
		headers,
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: {
				name: "web_search_exa",
				arguments: {
					query: request.query,
					type: "auto",
					livecrawl: "fallback",
					numResults: request.maxSources,
					contextMaxCharacters: request.contextMaxCharacters,
				},
			},
		}),
		signal,
	});
	if (!response.ok) {
		await response.body?.cancel();
		throw new Error(`Exa request failed (${response.status})`);
	}
	const reader = response.body?.getReader();
	if (!reader) throw new Error("Exa returned no response body");
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	try {
		while (true) {
			signal.throwIfAborted();
			const chunk = await reader.read();
			if (chunk.done) break;
			bytes += chunk.value.byteLength;
			if (bytes > MAX_RESPONSE_BYTES) throw new Error("Exa source-byte budget exceeded");
			chunks.push(chunk.value);
		}
	} finally {
		await reader.cancel();
		reader.releaseLock();
	}
	const raw = Buffer.concat(chunks).toString("utf8");
	try {
		const direct = extractText(JSON.parse(raw) as unknown);
		if (direct !== undefined) return direct;
	} catch (error) {
		if (!(error instanceof SyntaxError)) throw error;
	}
	return parseSse(raw);
}

export function createExaSearch(): SearchAdapter {
	let tail: Promise<void> = Promise.resolve();
	let lastStart = 0;
	return {
		search(request, signal) {
			const result = tail.then(async () => {
				signal.throwIfAborted();
				const wait = Math.max(0, lastStart + SEARCH_START_INTERVAL_MS - Date.now());
				if (wait > 0) await delay(wait, undefined, { signal });
				signal.throwIfAborted();
				lastStart = Date.now();
				const text = await callExa(request, signal);
				if (text === undefined) throw new Error("Exa returned an invalid search response");
				return { backend: "exa" as const, model: null, text, sources: [], fallback: null };
			});
			tail = result.then(
				() => undefined,
				() => undefined,
			);
			// A cancelled queued call must return before the preceding search finishes.
			return new Promise<SearchResult>((resolve, reject) => {
				const onAbort = () => reject(signal.reason);
				signal.addEventListener("abort", onAbort, { once: true });
				result.then(
					(value) => {
						signal.removeEventListener("abort", onAbort);
						resolve(value);
					},
					(error: unknown) => {
						signal.removeEventListener("abort", onAbort);
						reject(error);
					},
				);
				if (signal.aborted) onAbort();
			});
		},
	};
}
