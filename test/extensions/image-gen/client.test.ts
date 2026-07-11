import { afterEach, describe, expect, it, vi } from "vitest";
import {
	editImage,
	generateImage,
	resolveCodexAuth,
	type CodexAuth,
} from "../../../src/extensions/image-gen/client.ts";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const AUTH: CodexAuth = { token: "header.payload.signature", accountId: "account-1" };

interface FetchCallInit {
	method?: string;
	headers?: Headers | Record<string, string> | Array<[string, string]>;
	body?: unknown;
	signal?: AbortSignal | null;
}

function jwt(payload: unknown): string {
	return `header.${Buffer.from(JSON.stringify(payload) ?? "null").toString("base64url")}.signature`;
}

function imageResponse(): Response {
	return Response.json({ data: [{ b64_json: PNG.toString("base64") }] });
}

afterEach(() => vi.unstubAllGlobals());

describe("Codex image client", () => {
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
	])("rejects an unusable credential without exposing it", (token) => {
		expect(() => resolveCodexAuth(token)).toThrow(
			"The OpenAI Codex credential does not contain a usable ChatGPT account ID. Run /login again.",
		);
		try {
			resolveCodexAuth(token);
		} catch (error) {
			expect(String(error)).not.toContain(token);
		}
	});

	it("sends the exact generation request and returns the first PNG", async () => {
		const signal = new AbortController().signal;
		const fetchMock = vi.fn(async (_url: string | URL, _init?: FetchCallInit) => imageResponse());
		vi.stubGlobal("fetch", fetchMock);

		const result = await generateImage("blue whale", AUTH, signal);

		expect(result).toEqual({ bytes: PNG, base64: PNG.toString("base64"), mimeType: "image/png" });
		expect(fetchMock).toHaveBeenCalledOnce();
		const [url, init] = fetchMock.mock.calls[0] ?? [];
		expect(url).toBe("https://chatgpt.com/backend-api/codex/images/generations");
		expect(init).toMatchObject({ method: "POST", signal });
		expect(Object.fromEntries(new Headers(init?.headers))).toEqual({
			accept: "application/json",
			authorization: `Bearer ${AUTH.token}`,
			"chatgpt-account-id": AUTH.accountId,
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

	it("sends ordered image data URLs to the edit endpoint", async () => {
		const fetchMock = vi.fn(async (_url: string | URL, _init?: FetchCallInit) => imageResponse());
		vi.stubGlobal("fetch", fetchMock);
		await editImage(
			"add hat",
			[
				{ mimeType: "image/png", data: "cG5n" },
				{ mimeType: "image/jpeg", data: "anBlZw==" },
			],
			AUTH,
			undefined,
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

	it("does not retry HTTP failures and redacts echoed credentials", async () => {
		const fetchMock = vi.fn(async () => new Response(`failure ${AUTH.token}`, { status: 500 }));
		vi.stubGlobal("fetch", fetchMock);
		await expect(generateImage("x", AUTH, undefined)).rejects.toThrow(
			"Image generation failed with status 500: failure [redacted]",
		);
		expect(fetchMock).toHaveBeenCalledOnce();
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
		const pending = generateImage("x", AUTH, controller.signal);
		controller.abort();
		await expect(pending).rejects.toMatchObject({ name: "AbortError" });
	});

	it("extracts JSON error messages", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ error: { message: "not allowed" } }, { status: 403 })),
		);
		await expect(generateImage("x", AUTH, undefined)).rejects.toThrow(
			"Image generation failed with status 403: not allowed",
		);
	});

	const malformedResponses: Array<[Response, string]> = [
		[new Response("not json"), "non-JSON image response"],
		[Response.json({}), "invalid image response"],
		[Response.json({ data: [] }), "invalid image response"],
		[Response.json({ data: [{}] }), "invalid image response"],
		[Response.json({ data: [{ b64_json: "%%%" }] }), "invalid base64 image data"],
		[Response.json({ data: [{ b64_json: Buffer.from("no").toString("base64") }] }), "not PNG"],
	];
	it.each(malformedResponses)("rejects malformed successful responses", async (response, message) => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => response),
		);
		await expect(generateImage("x", AUTH, undefined)).rejects.toThrow(message);
	});
});
