import { afterEach, describe, expect, it, vi } from "vitest";
import {
	editImage,
	requestGeneratedImage as generateImage,
	resolveCodexAuth,
} from "../../../src/image-generation/client.ts";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 1, 2, 3]);
const XAI_TOKEN = "secret-token";

interface FetchCallInit {
	method?: string;
	headers?: Headers | Record<string, string> | Array<[string, string]>;
	body?: unknown;
	signal?: AbortSignal | null;
}

function jwt(payload: unknown): string {
	return `header.${Buffer.from(JSON.stringify(payload) ?? "null").toString("base64url")}.signature`;
}

function imageResponse(bytes: Buffer = JPEG): Response {
	return Response.json({ data: [{ b64_json: bytes.toString("base64") }] });
}

afterEach(() => vi.unstubAllGlobals());

describe("image generation clients", () => {
	it("extracts the ChatGPT account ID from a Codex OAuth JWT", () => {
		const token = jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "account-7" } });
		expect(resolveCodexAuth(token)).toEqual({ token, accountId: "account-7" });
	});

	it.each([
		"bad",
		"one.two.three.four",
		"header.%%%.signature",
		jwt(null),
		jwt({}),
		jwt({ "https://api.openai.com/auth": {} }),
		jwt({ "https://api.openai.com/auth": { chatgpt_account_id: " " } }),
		jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "secret\naccount" } }),
	])("rejects an unusable Codex credential without exposing it", (token) => {
		expect(() => resolveCodexAuth(token)).toThrow(
			"The OpenAI Codex credential does not contain a usable ChatGPT account ID. Run /login again.",
		);
		try {
			resolveCodexAuth(token);
		} catch (error) {
			expect(String(error)).not.toContain(token);
		}
	});

	it("sends an OpenAI generation request through the Codex image backend", async () => {
		const token = jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "account-1" } });
		const signal = new AbortController().signal;
		const fetchMock = vi.fn(async (_url: string | URL, _init?: FetchCallInit) => imageResponse(PNG));
		vi.stubGlobal("fetch", fetchMock);

		const result = await generateImage("openai", "blue whale", token, signal);

		expect(result).toEqual({ bytes: PNG, mimeType: "image/png" });
		const [url, init] = fetchMock.mock.calls[0] ?? [];
		expect(url).toBe("https://chatgpt.com/backend-api/codex/images/generations");
		expect(init).toMatchObject({ method: "POST", signal });
		expect(Object.fromEntries(new Headers(init?.headers))).toEqual({
			accept: "application/json",
			authorization: `Bearer ${token}`,
			"chatgpt-account-id": "account-1",
			"content-type": "application/json",
			originator: "pi",
		});
		expect(JSON.parse(String(init?.body))).toEqual({
			prompt: "blue whale",
			model: "gpt-image-2",
			background: "auto",
			quality: "auto",
			size: "auto",
		});
	});

	it("sends ordered edit images to OpenAI", async () => {
		const token = jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "account-1" } });
		const fetchMock = vi.fn(async (_url: string | URL, _init?: FetchCallInit) => imageResponse(PNG));
		vi.stubGlobal("fetch", fetchMock);
		await editImage(
			"openai",
			"add hat",
			[
				{ mimeType: "image/png", data: "cG5n" },
				{ mimeType: "image/jpeg", data: "anBlZw==" },
			],
			token,
		);
		const [url, init] = fetchMock.mock.calls[0] ?? [];
		expect(url).toBe("https://chatgpt.com/backend-api/codex/images/edits");
		expect(JSON.parse(String(init?.body))).toMatchObject({
			images: [{ image_url: "data:image/png;base64,cG5n" }, { image_url: "data:image/jpeg;base64,anBlZw==" }],
			prompt: "add hat",
			model: "gpt-image-2",
			size: "auto",
			quality: "auto",
		});
	});

	it("reports OpenAI failures without retrying or exposing credentials", async () => {
		const token = jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "account-1" } });
		const fetchMock = vi.fn(async () => new Response(`failure ${token}`, { status: 500 }));
		vi.stubGlobal("fetch", fetchMock);
		await expect(generateImage("openai", "x", token)).rejects.toThrow(
			"OpenAI Codex image generation failed with status 500: failure [redacted]",
		);
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	it("redacts OpenAI credentials from transport failures", async () => {
		const accountId = "account-secret";
		const token = jwt({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } });
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error(`transport rejected ${token} for ${accountId}`);
			}),
		);
		let failure: unknown;
		try {
			await generateImage("openai", "x", token);
		} catch (error) {
			failure = error;
		}
		const message = failure instanceof Error ? failure.message : "";
		expect(message).toContain("transport rejected [redacted] for [redacted]");
		expect(message).not.toContain(token);
		expect(message).not.toContain(accountId);
	});

	it.each([
		[new Response("not json"), "non-JSON image response"],
		[imageResponse(JPEG), "unsupported image data"],
	] satisfies Array<[Response, string]>)("rejects invalid OpenAI responses", async (response, message) => {
		const token = jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "account-1" } });
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => response),
		);
		await expect(generateImage("openai", "x", token)).rejects.toThrow(message);
	});

	it("preserves OpenAI request cancellation", async () => {
		const token = jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "account-1" } });
		const controller = new AbortController();
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: string, init?: FetchCallInit) => {
				return new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
				});
			}),
		);
		const pending = generateImage("openai", "x", token, controller.signal);
		controller.abort(new DOMException("Aborted", "AbortError"));
		await expect(pending).rejects.toMatchObject({ name: "AbortError" });
	});

	it("sends an xAI generation request and validates returned bytes", async () => {
		const signal = new AbortController().signal;
		const fetchMock = vi.fn(async (_url: string | URL, _init?: FetchCallInit) => imageResponse());
		vi.stubGlobal("fetch", fetchMock);

		const result = await generateImage("xai", "blue whale", XAI_TOKEN, signal);

		expect(result).toEqual({ bytes: JPEG, mimeType: "image/jpeg" });
		const [url, init] = fetchMock.mock.calls[0] ?? [];
		expect(url).toBe("https://api.x.ai/v1/images/generations");
		expect(init).toMatchObject({ method: "POST" });
		expect(Object.fromEntries(new Headers(init?.headers))).toEqual({
			accept: "application/json",
			authorization: `Bearer ${XAI_TOKEN}`,
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

	it("sends singular and plural xAI edit fields", async () => {
		const fetchMock = vi.fn(async (_url: string | URL, _init?: FetchCallInit) => imageResponse());
		vi.stubGlobal("fetch", fetchMock);
		await editImage("xai", "add hat", [{ mimeType: "image/png", data: "cG5n" }], XAI_TOKEN);
		const [url, initialInit] = fetchMock.mock.calls[0] ?? [];
		expect(url).toBe("https://api.x.ai/v1/images/edits");
		expect(JSON.parse(String(initialInit?.body))).toMatchObject({
			image: { url: "data:image/png;base64,cG5n" },
			prompt: "add hat",
		});

		await editImage(
			"xai",
			"combine",
			[
				{ mimeType: "image/png", data: "cG5n" },
				{ mimeType: "image/jpeg", data: "anBlZw==" },
			],
			XAI_TOKEN,
		);
		const [, init] = fetchMock.mock.calls[1] ?? [];
		expect(JSON.parse(String(init?.body))).toMatchObject({
			images: [{ url: "data:image/png;base64,cG5n" }, { url: "data:image/jpeg;base64,anBlZw==" }],
		});
	});

	it("retries transient xAI failures and redacts echoed credentials", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(new Response("temporary", { status: 500 }))
			.mockResolvedValueOnce(imageResponse());
		vi.stubGlobal("fetch", fetchMock);
		await expect(generateImage("xai", "x", XAI_TOKEN)).resolves.toMatchObject({ mimeType: "image/jpeg" });
		expect(fetchMock).toHaveBeenCalledTimes(2);

		fetchMock.mockReset().mockResolvedValue(new Response(`failure ${XAI_TOKEN}`, { status: 403 }));
		await expect(generateImage("xai", "x", XAI_TOKEN)).rejects.toThrow("failure [redacted]");
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
		const pending = generateImage("xai", "x", XAI_TOKEN, controller.signal);
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
		await expect(generateImage("xai", "x", XAI_TOKEN)).rejects.toThrow(message);
	});
});
