import {
	OPENAI_IMAGE_API_BASE_URL,
	OPENAI_IMAGE_MODEL,
	XAI_API_BASE_URL,
	XAI_IMAGE_MODEL,
	type ImageProvider,
} from "./constants.ts";

const MAX_ERROR_BODY_BYTES = 8192;
const MAX_ERROR_MESSAGE_LENGTH = 2000;
const REQUEST_TIMEOUT_MS = 60_000;
const MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 500;

export interface CodexAuth {
	token: string;
	accountId: string;
}

export interface EditImage {
	mimeType: "image/png" | "image/jpeg" | "image/webp";
	data: string;
}

export interface GeneratedImage {
	bytes: Buffer;
	base64: string;
	mimeType: EditImage["mimeType"];
}

interface HttpResponse {
	ok: boolean;
	status: number;
	body: ReadableStream<Uint8Array> | null;
	json(): Promise<unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function resolveCodexAuth(token: string): CodexAuth {
	const invalidCredential = () =>
		new Error("The OpenAI Codex credential does not contain a usable ChatGPT account ID. Run /login again.");
	const segments = token.split(".");
	if (segments.length !== 3 || !segments[1]) throw invalidCredential();
	if (!/^[A-Za-z0-9_-]+$/.test(segments[1]) || segments[1].length % 4 === 1) throw invalidCredential();

	let payload: unknown;
	try {
		const decoded = Buffer.from(segments[1], "base64url");
		if (decoded.toString("base64url") !== segments[1]) throw invalidCredential();
		payload = JSON.parse(decoded.toString("utf8"));
	} catch {
		throw invalidCredential();
	}
	if (!isRecord(payload)) throw invalidCredential();
	const authClaim = payload["https://api.openai.com/auth"];
	if (!isRecord(authClaim)) throw invalidCredential();
	const accountId = authClaim.chatgpt_account_id;
	if (typeof accountId !== "string" || !accountId.trim()) throw invalidCredential();
	return { token, accountId: accountId.trim() };
}

async function boundedError(response: HttpResponse): Promise<string> {
	if (!response.body) return "";
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let length = 0;
	try {
		while (length < MAX_ERROR_BODY_BYTES) {
			const result = await reader.read();
			if (result.done) break;
			const chunk = result.value.subarray(0, MAX_ERROR_BODY_BYTES - length);
			chunks.push(chunk);
			length += chunk.length;
			if (chunk.length < result.value.length) break;
		}
	} finally {
		await reader.cancel().catch(() => undefined);
	}
	return Buffer.concat(
		chunks.map((chunk) => Buffer.from(chunk)),
		length,
	)
		.toString()
		.trim();
}

function serverErrorMessage(body: string, token: string): string {
	let message = body;
	try {
		const value: unknown = JSON.parse(body);
		if (isRecord(value)) {
			if (isRecord(value.error) && typeof value.error.message === "string") message = value.error.message;
			else if (typeof value.message === "string") message = value.message;
		}
	} catch {
		// Plain-text error body.
	}
	return message.replaceAll(token, "[redacted]").slice(0, MAX_ERROR_MESSAGE_LENGTH).trim();
}

export function detectImageMimeType(bytes: Buffer): GeneratedImage["mimeType"] | undefined {
	if (
		bytes.length >= 8 &&
		bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
	) {
		return "image/png";
	}
	if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
	if (
		bytes.length >= 12 &&
		bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
		bytes.subarray(8, 12).toString("ascii") === "WEBP"
	) {
		return "image/webp";
	}
	return undefined;
}

function decodeImageResponse(value: unknown, service: "OpenAI Codex" | "xAI", pngOnly: boolean): GeneratedImage {
	if (!isRecord(value) || !Array.isArray(value.data) || !isRecord(value.data[0])) {
		throw new Error(`${service} returned an invalid image response`);
	}
	const encoded = value.data[0].b64_json;
	if (typeof encoded !== "string" || !encoded.trim()) throw new Error(`${service} returned an invalid image response`);
	const base64 = encoded.trim();
	if (!/^[A-Za-z0-9+/]*={0,2}$/.test(base64) || base64.length % 4 === 1) {
		throw new Error(`${service} returned invalid base64 image data`);
	}
	const bytes = Buffer.from(base64, "base64");
	if (bytes.toString("base64").replace(/=+$/, "") !== base64.replace(/=+$/, "")) {
		throw new Error(`${service} returned invalid base64 image data`);
	}
	const mimeType = detectImageMimeType(bytes);
	if (!mimeType || (pngOnly && mimeType !== "image/png")) {
		throw new Error(`${service} returned unsupported image data`);
	}
	return { bytes, base64: bytes.toString("base64"), mimeType };
}

async function requestOpenAIImage(
	operation: "generation" | "edit",
	body: Record<string, unknown>,
	auth: CodexAuth,
	signal?: AbortSignal,
): Promise<GeneratedImage> {
	const route = operation === "generation" ? "generations" : "edits";
	const response = (await fetch(`${OPENAI_IMAGE_API_BASE_URL}/${route}`, {
		method: "POST",
		headers: {
			Accept: "application/json",
			Authorization: `Bearer ${auth.token}`,
			"chatgpt-account-id": auth.accountId,
			"Content-Type": "application/json",
			originator: "pi",
		},
		body: JSON.stringify(body),
		signal,
	})) as HttpResponse;
	if (!response.ok) {
		const message = serverErrorMessage(await boundedError(response), auth.token);
		throw new Error(
			`OpenAI Codex image ${operation} failed with status ${response.status}${message ? `: ${message}` : ""}`,
		);
	}
	let value: unknown;
	try {
		value = await response.json();
	} catch {
		throw new Error("OpenAI Codex returned a non-JSON image response");
	}
	return decodeImageResponse(value, "OpenAI Codex", true);
}

function retryable(status: number): boolean {
	return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

async function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const timeout = setTimeout(() => {
			signal?.removeEventListener("abort", abort);
			resolve();
		}, milliseconds);
		const abort = () => {
			clearTimeout(timeout);
			signal?.removeEventListener("abort", abort);
			reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
		};
		if (signal?.aborted) abort();
		else signal?.addEventListener("abort", abort, { once: true });
	});
}

async function requestXaiImage(
	operation: "generation" | "edit",
	body: Record<string, unknown>,
	token: string,
	signal?: AbortSignal,
): Promise<GeneratedImage> {
	const route = operation === "generation" ? "generations" : "edits";
	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
		const requestSignal = signal
			? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
			: AbortSignal.timeout(REQUEST_TIMEOUT_MS);
		let response: HttpResponse;
		try {
			response = (await fetch(`${XAI_API_BASE_URL}/images/${route}`, {
				method: "POST",
				headers: {
					Accept: "application/json",
					Authorization: `Bearer ${token}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify(body),
				signal: requestSignal,
			})) as HttpResponse;
		} catch (error) {
			if (signal?.aborted) throw signal.reason;
			if (attempt === MAX_ATTEMPTS) throw error;
			await delay(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1), signal);
			continue;
		}
		if (response.ok) {
			let value: unknown;
			try {
				value = await response.json();
			} catch {
				throw new Error("xAI returned a non-JSON image response");
			}
			return decodeImageResponse(value, "xAI", false);
		}
		const message = serverErrorMessage(await boundedError(response), token);
		if (!retryable(response.status) || attempt === MAX_ATTEMPTS) {
			throw new Error(
				`xAI image ${operation} failed with status ${response.status}${message ? `: ${message}` : ""}`,
			);
		}
		await delay(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1), signal);
	}
	throw new Error(`xAI image ${operation} failed`);
}

export function generateImage(
	provider: ImageProvider,
	prompt: string,
	token: string,
	signal?: AbortSignal,
): Promise<GeneratedImage> {
	if (provider === "openai") {
		return requestOpenAIImage(
			"generation",
			{ prompt, model: OPENAI_IMAGE_MODEL, background: "auto", quality: "auto", size: "auto" },
			resolveCodexAuth(token),
			signal,
		);
	}
	return requestXaiImage(
		"generation",
		{ model: XAI_IMAGE_MODEL, prompt, n: 1, resolution: "1k", response_format: "b64_json" },
		token,
		signal,
	);
}

export function editImage(
	provider: ImageProvider,
	prompt: string,
	images: readonly EditImage[],
	token: string,
	signal?: AbortSignal,
): Promise<GeneratedImage> {
	if (provider === "openai") {
		return requestOpenAIImage(
			"edit",
			{
				images: images.map((image) => ({ image_url: `data:${image.mimeType};base64,${image.data}` })),
				prompt,
				model: OPENAI_IMAGE_MODEL,
				background: "auto",
				quality: "auto",
				size: "auto",
			},
			resolveCodexAuth(token),
			signal,
		);
	}
	const references = images.map((image) => ({ url: `data:${image.mimeType};base64,${image.data}` }));
	return requestXaiImage(
		"edit",
		{
			model: XAI_IMAGE_MODEL,
			prompt,
			n: 1,
			resolution: "1k",
			response_format: "b64_json",
			...(references.length === 1 ? { image: references[0] } : { images: references }),
		},
		token,
		signal,
	);
}
