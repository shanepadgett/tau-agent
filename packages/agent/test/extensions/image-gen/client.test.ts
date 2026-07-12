import { afterEach, describe, expect, it, vi } from "vitest";
import { editImage, generateImage } from "../../../extensions/image-gen/client.ts";

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 1, 2, 3]);
const TOKEN = "secret-token";

interface FetchCallInit {
	method?: string;
	headers?: Headers | Record<string, string> | Array<[string, string]>;
	body?: unknown;
	signal?: AbortSignal | null;
}

function imageResponse(): Response {
	return Response.json({ data: [{ b64_json: JPEG.toString("base64"), mime_type: "image/jpeg" }] });
}

afterEach(() => vi.unstubAllGlobals());

describe("xAI image client", () => {
	it("sends the generation request and validates returned bytes", async () => {
		const signal = new AbortController().signal;
		const fetchMock = vi.fn(async (_url: string | URL, _init?: FetchCallInit) => imageResponse());
		vi.stubGlobal("fetch", fetchMock);

		const result = await generateImage("blue whale", TOKEN, signal);

		expect(result).toEqual({ bytes: JPEG, base64: JPEG.toString("base64"), mimeType: "image/jpeg" });
		const [url, init] = fetchMock.mock.calls[0] ?? [];
		expect(url).toBe("https://api.x.ai/v1/images/generations");
		expect(init).toMatchObject({ method: "POST" });
		expect(Object.fromEntries(new Headers(init?.headers))).toEqual({
			accept: "application/json",
			authorization: `Bearer ${TOKEN}`,
			"content-type": "application/json",
		});
		expect(JSON.parse(String(init?.body))).toEqual({
			model: "grok-imagine-image-quality",
			prompt: "blue whale",
			n: 1,
			resolution: "1k",
			response_format: "b64_json",
		});
	});

	it("sends one image with the singular edit field", async () => {
		const fetchMock = vi.fn(async (_url: string | URL, _init?: FetchCallInit) => imageResponse());
		vi.stubGlobal("fetch", fetchMock);
		await editImage("add hat", [{ mimeType: "image/png", data: "cG5n" }], TOKEN);
		const [url, init] = fetchMock.mock.calls[0] ?? [];
		expect(url).toBe("https://api.x.ai/v1/images/edits");
		expect(JSON.parse(String(init?.body))).toMatchObject({
			image: { url: "data:image/png;base64,cG5n" },
			prompt: "add hat",
		});
	});

	it("sends multiple images with the plural edit field", async () => {
		const fetchMock = vi.fn(async (_url: string | URL, _init?: FetchCallInit) => imageResponse());
		vi.stubGlobal("fetch", fetchMock);
		await editImage(
			"combine",
			[
				{ mimeType: "image/png", data: "cG5n" },
				{ mimeType: "image/jpeg", data: "anBlZw==" },
			],
			TOKEN,
		);
		const [, init] = fetchMock.mock.calls[0] ?? [];
		expect(JSON.parse(String(init?.body))).toMatchObject({
			images: [{ url: "data:image/png;base64,cG5n" }, { url: "data:image/jpeg;base64,anBlZw==" }],
		});
	});

	it("retries transient failures and redacts echoed credentials", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(new Response("temporary", { status: 500 }))
			.mockResolvedValueOnce(imageResponse());
		vi.stubGlobal("fetch", fetchMock);
		await expect(generateImage("x", TOKEN)).resolves.toMatchObject({ mimeType: "image/jpeg" });
		expect(fetchMock).toHaveBeenCalledTimes(2);

		fetchMock.mockReset().mockResolvedValue(new Response(`failure ${TOKEN}`, { status: 403 }));
		await expect(generateImage("x", TOKEN)).rejects.toThrow("failure [redacted]");
	});

	it("preserves request cancellation", async () => {
		const controller = new AbortController();
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: string, init?: FetchCallInit) => {
				return new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
				});
			}),
		);
		const pending = generateImage("x", TOKEN, controller.signal);
		controller.abort(new DOMException("Aborted", "AbortError"));
		await expect(pending).rejects.toMatchObject({ name: "AbortError" });
	});

	const malformedResponses: Array<[Response, string]> = [
		[Response.json({}), "invalid image response"],
		[Response.json({ data: [] }), "invalid image response"],
		[Response.json({ data: [{}] }), "invalid image response"],
		[Response.json({ data: [{ b64_json: "%%%" }] }), "invalid base64 image data"],
		[Response.json({ data: [{ b64_json: Buffer.from("no").toString("base64") }] }), "unsupported image data"],
	];
	it.each(malformedResponses)("rejects malformed successful responses", async (response, message) => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => response),
		);
		await expect(generateImage("x", TOKEN)).rejects.toThrow(message);
	});
});
