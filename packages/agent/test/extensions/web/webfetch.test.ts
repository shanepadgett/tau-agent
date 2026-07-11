import { afterEach, describe, expect, it, vi } from "vitest";
import { createWebFetchTool } from "../../../extensions/web/webfetch.ts";
import { extensionContext, type FetchCallInit, firstText, testRowState, waitForAbort } from "./helpers.ts";

afterEach(() => vi.unstubAllGlobals());

describe("webfetch", () => {
	it("rejects invalid and unsupported URLs before fetch", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		const tool = createWebFetchTool(testRowState);
		await expect(tool.execute("id", { url: "bad url" }, undefined, undefined, extensionContext)).rejects.toThrow(
			"Invalid URL",
		);
		await expect(
			tool.execute("id", { url: "file:///tmp/a" }, undefined, undefined, extensionContext),
		).rejects.toThrow("URL must use http:// or https://");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("sends format-specific headers and converts HTML to Markdown, text, or raw HTML", async () => {
		const calls: FetchCallInit[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: string, init?: FetchCallInit) => {
				calls.push(init ?? {});
				return new Response("<h1>Hello</h1><p>World</p>", {
					headers: { "content-type": "Text/HTML; charset=utf-8" },
				});
			}),
		);
		const tool = createWebFetchTool(testRowState);

		const markdown = await tool.execute("id", { url: "https://example.com" }, undefined, undefined, extensionContext);
		const text = await tool.execute(
			"id",
			{ url: "https://example.com", format: "text", timeout: 44.8 },
			undefined,
			undefined,
			extensionContext,
		);
		const html = await tool.execute(
			"id",
			{ url: "https://example.com", format: "html" },
			undefined,
			undefined,
			extensionContext,
		);
		expect(firstText(markdown)).toBe("# Hello\nWorld");
		expect(firstText(text)).toBe("Hello\nWorld");
		expect(firstText(html)).toBe("<h1>Hello</h1><p>World</p>");
		expect(new Headers(calls[0]?.headers).get("accept")).toContain("text/markdown");
		expect(new Headers(calls[1]?.headers).get("accept")).toContain("text/plain");
		expect(new Headers(calls[2]?.headers).get("accept")).toContain("text/html");
		expect(text.details).toMatchObject({ url: "https://example.com/", format: "text", mime: "text/html" });
		expect(text.details?.bytes).toBe(26);
	});

	it("passes through non-HTML text and treats SVG as text", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(new Response("plain", { headers: { "content-type": "text/plain" } }))
			.mockResolvedValueOnce(
				new Response("<svg><text>x</text></svg>", { headers: { "content-type": "image/svg+xml" } }),
			);
		vi.stubGlobal("fetch", fetchMock);
		const tool = createWebFetchTool(testRowState);
		expect(
			firstText(await tool.execute("id", { url: "https://example.com/a" }, undefined, undefined, extensionContext)),
		).toBe("plain");
		const svg = await tool.execute(
			"id",
			{ url: "https://example.com/a.svg" },
			undefined,
			undefined,
			extensionContext,
		);
		expect(firstText(svg)).toBe("<svg><text>x</text></svg>");
		expect(svg.content).toHaveLength(1);
	});

	it("returns inline non-SVG images", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(Uint8Array.from([1, 2, 3]), { headers: { "content-type": "image/png" } })),
		);
		const result = await createWebFetchTool(testRowState).execute(
			"id",
			{ url: "https://example.com/a.png" },
			undefined,
			undefined,
			extensionContext,
		);
		expect(firstText(result)).toContain("Fetched image from https://example.com/a.png (image/png)");
		expect(result.content[1]).toEqual({ type: "image", data: "AQID", mimeType: "image/png" });
	});

	it("retries Cloudflare challenges once and cancels the first body", async () => {
		let cancelled = false;
		const challengeBody = new ReadableStream<Uint8Array>({
			cancel() {
				cancelled = true;
			},
		});
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(new Response(challengeBody, { status: 403, headers: { "cf-mitigated": "challenge" } }))
			.mockResolvedValueOnce(new Response("ok", { headers: { "content-type": "text/plain" } }));
		vi.stubGlobal("fetch", fetchMock);
		const result = await createWebFetchTool(testRowState).execute(
			"id",
			{ url: "https://example.com" },
			undefined,
			undefined,
			extensionContext,
		);
		expect(firstText(result)).toBe("ok");
		expect(cancelled).toBe(true);
		expect(new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get("user-agent")).toBe("pi");
	});

	it("rejects HTTP failures and declared or streamed bodies over 5 MB", async () => {
		let streamCancelled = false;
		const oversizedStream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array(5 * 1024 * 1024 + 1));
			},
			cancel() {
				streamCancelled = true;
			},
		});
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(new Response("no", { status: 500 }))
			.mockResolvedValueOnce(new Response("", { headers: { "content-length": String(5 * 1024 * 1024 + 1) } }))
			.mockResolvedValueOnce(new Response(oversizedStream));
		vi.stubGlobal("fetch", fetchMock);
		const tool = createWebFetchTool(testRowState);
		await expect(
			tool.execute("id", { url: "https://example.com" }, undefined, undefined, extensionContext),
		).rejects.toThrow("status 500");
		await expect(
			tool.execute("id", { url: "https://example.com" }, undefined, undefined, extensionContext),
		).rejects.toThrow("Response too large");
		await expect(
			tool.execute("id", { url: "https://example.com" }, undefined, undefined, extensionContext),
		).rejects.toThrow("Response too large");
		expect(streamCancelled).toBe(true);
	});

	it("records truncation and keeps cancellation distinct from timeout", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(new Response(`${"x\n".repeat(2100)}`))
			.mockImplementation((_url: string, init?: FetchCallInit) => waitForAbort(init?.signal));
		vi.stubGlobal("fetch", fetchMock);
		const tool = createWebFetchTool(testRowState);
		const truncated = await tool.execute(
			"id",
			{ url: "https://example.com" },
			undefined,
			undefined,
			extensionContext,
		);
		expect(firstText(truncated)).toContain("[Output truncated:");
		expect(truncated.details?.truncation?.truncated).toBe(true);

		const controller = new AbortController();
		const cancelled = tool.execute(
			"id",
			{ url: "https://example.com" },
			controller.signal,
			undefined,
			extensionContext,
		);
		controller.abort();
		await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
		await expect(
			tool.execute("id", { url: "https://example.com", timeout: 0.5 }, undefined, undefined, extensionContext),
		).rejects.toThrow("Web fetch timed out after 0s");
	});
});
