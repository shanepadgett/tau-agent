import { afterEach, describe, expect, it, vi } from "vitest";
import { callExa } from "../../../src/extensions/web/exa.ts";
import { type FetchCallInit, waitForAbort } from "./helpers.ts";

function jsonResult(textItems: string[]): string {
	return JSON.stringify({
		jsonrpc: "2.0",
		id: 1,
		result: { content: textItems.map((text) => ({ type: "text", text })) },
	});
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

describe("Exa MCP transport", () => {
	it("sends the JSON-RPC request and optional trimmed API key", async () => {
		vi.stubEnv("EXA_API_KEY", "  secret  ");
		let request: FetchCallInit | undefined;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: string, init?: FetchCallInit) => {
				request = init;
				return new Response(jsonResult(["one", "two"]), { headers: { "content-type": "application/json" } });
			}),
		);

		await expect(callExa({ toolName: "web_search_exa", arguments: { query: "tau" } }, undefined, 25)).resolves.toBe(
			"one\ntwo",
		);
		expect(new Headers(request?.headers).get("x-api-key")).toBe("secret");
		expect(JSON.parse(String(request?.body))).toEqual({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: { name: "web_search_exa", arguments: { query: "tau" } },
		});
	});

	it("omits a blank key and parses single-line and multiline SSE events", async () => {
		vi.stubEnv("EXA_API_KEY", "   ");
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(new Response(`: ping\n\ndata: [DONE]\n\ndata: ${jsonResult(["single"])}\n\n`))
			.mockResolvedValueOnce(
				new Response(
					`event: message\ndata: {"jsonrpc":"2.0",\ndata: "id":1,"result":{"content":[{"type":"text","text":"multi"}]}}\n\n`,
				),
			);
		vi.stubGlobal("fetch", fetchMock);

		await expect(callExa({ toolName: "web_search_exa", arguments: {} }, undefined, 25)).resolves.toBe("single");
		expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).has("x-api-key")).toBe(false);
		await expect(callExa({ toolName: "get_code_context_exa", arguments: {} }, undefined, 25)).resolves.toBe("multi");
	});

	it("surfaces JSON-RPC and HTTP errors and returns undefined without text", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "quota" } })))
			.mockResolvedValueOnce(new Response("denied", { status: 429 }))
			.mockResolvedValueOnce(new Response(JSON.stringify({ result: { content: [{ type: "image" }] } })));
		vi.stubGlobal("fetch", fetchMock);

		await expect(callExa({ toolName: "web_search_exa", arguments: {} }, undefined, 25)).rejects.toThrow(
			"Exa JSON-RPC error: quota",
		);
		await expect(callExa({ toolName: "web_search_exa", arguments: {} }, undefined, 25)).rejects.toThrow(
			"Exa request failed (429): denied",
		);
		await expect(callExa({ toolName: "web_search_exa", arguments: {} }, undefined, 25)).resolves.toBeUndefined();
	});

	it("keeps caller cancellation distinct from timeout", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn((_url: string, init?: FetchCallInit) => waitForAbort(init?.signal)),
		);
		const controller = new AbortController();
		const cancelled = callExa({ toolName: "web_search_exa", arguments: {} }, controller.signal, 25);
		controller.abort();
		await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
		await expect(callExa({ toolName: "web_search_exa", arguments: {} }, undefined, 0)).rejects.toMatchObject({
			name: "TimeoutError",
		});
	});
});
