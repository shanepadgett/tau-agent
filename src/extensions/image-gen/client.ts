const CODEX_IMAGES_URL = "https://chatgpt.com/backend-api/codex/images";
const MODEL = "gpt-image-2";
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_ERROR_BODY_BYTES = 8192;
const MAX_ERROR_MESSAGE_LENGTH = 2000;

interface FetchResponse {
	ok: boolean;
	status: number;
	body: ReadableStream<Uint8Array> | null;
	json(): Promise<unknown>;
}

export interface CodexAuth {
	token: string;
	accountId: string;
}

export interface EditImage {
	mimeType: "image/png" | "image/jpeg" | "image/webp";
	data: string;
}

interface GeneratedImage {
	bytes: Buffer;
	base64: string;
	mimeType: "image/png";
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

async function readBoundedError(response: FetchResponse): Promise<string> {
	if (!response.body) return "";
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let length = 0;
	try {
		while (length < MAX_ERROR_BODY_BYTES) {
			const result = await reader.read();
			if (result.done) break;
			const remaining = MAX_ERROR_BODY_BYTES - length;
			const chunk = result.value.subarray(0, remaining);
			chunks.push(chunk);
			length += chunk.length;
			if (chunk.length < result.value.length) break;
		}
	} finally {
		await reader.cancel().catch(() => undefined);
	}
	const bytes = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.length;
	}
	return new TextDecoder().decode(bytes);
}

function serverErrorMessage(body: string, token: string): string {
	let message = body.trim();
	try {
		const parsed: unknown = JSON.parse(message);
		if (isRecord(parsed)) {
			const error = parsed.error;
			if (isRecord(error) && typeof error.message === "string") message = error.message;
			else if (typeof parsed.message === "string") message = parsed.message;
		}
	} catch {
		// Plain-text error body.
	}
	return message.replaceAll(token, "[redacted]").slice(0, MAX_ERROR_MESSAGE_LENGTH).trim();
}

function decodeImageResponse(value: unknown): GeneratedImage {
	if (!isRecord(value) || !Array.isArray(value.data) || value.data.length === 0 || !isRecord(value.data[0])) {
		throw new Error("OpenAI Codex returned an invalid image response");
	}
	const encoded = value.data[0].b64_json;
	if (typeof encoded !== "string" || !encoded.trim()) {
		throw new Error("OpenAI Codex returned an invalid image response");
	}
	const base64 = encoded.trim();
	if (!/^[A-Za-z0-9+/]*={0,2}$/.test(base64) || base64.length % 4 === 1) {
		throw new Error("OpenAI Codex returned invalid base64 image data");
	}
	const bytes = Buffer.from(base64, "base64");
	if (bytes.toString("base64").replace(/=+$/, "") !== base64.replace(/=+$/, "")) {
		throw new Error("OpenAI Codex returned invalid base64 image data");
	}
	if (bytes.length < PNG_SIGNATURE.length || !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
		throw new Error("OpenAI Codex returned image data that is not PNG");
	}
	return { bytes, base64: bytes.toString("base64"), mimeType: "image/png" };
}

async function requestImage(
	operation: "generation" | "edit",
	body: Record<string, unknown>,
	auth: CodexAuth,
	signal: AbortSignal | undefined,
): Promise<GeneratedImage> {
	const route = operation === "generation" ? "generations" : "edits";
	const response = (await fetch(`${CODEX_IMAGES_URL}/${route}`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${auth.token}`,
			"chatgpt-account-id": auth.accountId,
			originator: "pi",
			Accept: "application/json",
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
		signal,
	})) as FetchResponse;
	if (!response.ok) {
		const message = serverErrorMessage(await readBoundedError(response), auth.token);
		throw new Error(`Image ${operation} failed with status ${response.status}${message ? `: ${message}` : ""}`);
	}

	let value: unknown;
	try {
		value = await response.json();
	} catch {
		throw new Error("OpenAI Codex returned a non-JSON image response");
	}
	return decodeImageResponse(value);
}

export function generateImage(
	prompt: string,
	auth: CodexAuth,
	signal: AbortSignal | undefined,
): Promise<GeneratedImage> {
	return requestImage(
		"generation",
		{ prompt, model: MODEL, background: "auto", quality: "auto", size: "auto" },
		auth,
		signal,
	);
}

export function editImage(
	prompt: string,
	images: readonly EditImage[],
	auth: CodexAuth,
	signal: AbortSignal | undefined,
): Promise<GeneratedImage> {
	return requestImage(
		"edit",
		{
			images: images.map((image) => ({ image_url: `data:${image.mimeType};base64,${image.data}` })),
			prompt,
			model: MODEL,
			background: "auto",
			quality: "auto",
			size: "auto",
		},
		auth,
		signal,
	);
}
