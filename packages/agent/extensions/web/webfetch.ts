import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import { BoundedTextResultBuilder, type BoundedTextOverflowDetails } from "../../shared/bounded-text-result.ts";
import type { TemporaryOutputStore } from "../../shared/temporary-output-store.ts";
import { formatToolRowTitle, type ToolRowStateStore } from "../../shared/tool-row-state.js";
import { htmlToMarkdown, htmlToText } from "./html.ts";
import { normalizeTimeout } from "./limits.ts";
import { renderWebToolResult, truncateCallSummary } from "./tool-output.ts";

const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

const webFetchParams = Type.Object(
	{
		url: Type.String({ description: "URL to fetch (http:// or https://)" }),
		format: Type.Optional(
			StringEnum(["markdown", "text", "html"] as const, { description: "Output format (default: markdown)" }),
		),
		timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (default: 30, max: 600)" })),
	},
	{ additionalProperties: false },
);

type WebFetchParams = Static<typeof webFetchParams>;
type WebFetchFormat = "markdown" | "text" | "html";
interface WebFetchDetails {
	url: string;
	requestedUrl: string;
	format: WebFetchFormat;
	mime: string;
	bytes: number;
	overflow: BoundedTextOverflowDetails;
}

type WebFetchContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

interface WebFetchResult {
	content: WebFetchContent[];
	details: WebFetchDetails;
}

async function readResponseBody(response: Response, signal: AbortSignal): Promise<Uint8Array> {
	if (!response.body) return new Uint8Array();
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	try {
		while (true) {
			signal.throwIfAborted();
			const next = await reader.read();
			if (next.done) break;
			bytes += next.value.byteLength;
			if (bytes > MAX_RESPONSE_BYTES) {
				throw new Error("Response too large (limit is 5MB)");
			}
			chunks.push(next.value);
		}
	} finally {
		await reader.cancel().catch(() => undefined);
		reader.releaseLock();
	}
	return Buffer.concat(chunks, bytes);
}

function renderCallSummary(args: WebFetchParams): string {
	return truncateCallSummary((args.url ?? "").trim());
}

function parseFetchUrl(raw: string): URL {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new Error(`Invalid URL: ${raw}`);
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error("URL must use http:// or https://");
	}
	return url;
}

function acceptHeaderForFormat(format: WebFetchFormat): string {
	if (format === "markdown") return "text/markdown;q=1.0, text/plain;q=0.8, text/html;q=0.7, */*;q=0.1";
	if (format === "text") return "text/plain;q=1.0, text/markdown;q=0.9, text/html;q=0.8, */*;q=0.1";
	return "text/html;q=1.0, application/xhtml+xml;q=0.9, */*;q=0.1";
}

async function fetchWithChallengeRetry(
	url: string,
	headers: Record<string, string>,
	signal: AbortSignal,
): Promise<Response> {
	const first = await fetch(url, { method: "GET", headers, signal });
	if (first.status !== 403 || first.headers.get("cf-mitigated")?.toLowerCase() !== "challenge") return first;
	await first.body?.cancel().catch(() => undefined);
	return fetch(url, {
		method: "GET",
		headers: { ...headers, "User-Agent": "pi" },
		signal,
	});
}

async function assertDeclaredBodySizeOk(response: Response): Promise<void> {
	const declaredLength = response.headers.get("content-length");
	if (declaredLength === null) return;
	const bytes = Number.parseInt(declaredLength, 10);
	if (!Number.isFinite(bytes) || bytes <= MAX_RESPONSE_BYTES) return;
	await response.body?.cancel().catch(() => undefined);
	throw new Error("Response too large (limit is 5MB)");
}

function formatFetchedText(raw: string, format: WebFetchFormat, mime: string, finalUrl: string): string {
	if (format === "html") return raw;
	const isHtml = mime === "text/html" || mime === "application/xhtml+xml";
	if (!isHtml) return raw;
	return format === "text" ? htmlToText(raw) : htmlToMarkdown(raw, finalUrl);
}

async function executeWebFetch(
	params: WebFetchParams,
	signal: AbortSignal | undefined,
	onUpdate: ((update: { content: WebFetchContent[]; details: undefined }) => void | Promise<void>) | undefined,
	temporaryOutput: TemporaryOutputStore,
): Promise<WebFetchResult> {
	const url = parseFetchUrl(params.url);
	const format = params.format ?? "markdown";
	const timeout = normalizeTimeout(params.timeout, 30);
	await onUpdate?.({ content: [{ type: "text", text: "Fetching page..." }], details: undefined });
	const timeoutSignal = AbortSignal.timeout(timeout * 1000);
	const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
	const builder = new BoundedTextResultBuilder(temporaryOutput, "head");

	try {
		const headers = {
			"User-Agent":
				"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
			Accept: acceptHeaderForFormat(format),
			"Accept-Language": "en-US,en;q=0.9",
		};
		const response = await fetchWithChallengeRetry(url.toString(), headers, requestSignal);
		if (!response.ok) {
			await response.body?.cancel().catch(() => undefined);
			throw new Error(`Request failed with status ${response.status}`);
		}
		await assertDeclaredBodySizeOk(response);
		const mime = (response.headers.get("content-type")?.split(";", 1)[0] ?? "").trim().toLowerCase();
		const isImage = mime.startsWith("image/") && mime !== "image/svg+xml";
		const isText =
			!mime ||
			mime.startsWith("text/") ||
			mime === "application/json" ||
			mime.endsWith("+json") ||
			mime === "application/xml" ||
			mime.endsWith("+xml") ||
			mime === "application/javascript" ||
			mime === "application/x-javascript";
		if (!isImage && !isText) {
			await response.body?.cancel().catch(() => undefined);
			throw new Error(
				`Unsupported fetched content type: ${mime}. webfetch supports text and images, not binary downloads.`,
			);
		}
		const body = await readResponseBody(response, requestSignal);
		requestSignal.throwIfAborted();
		const details = {
			url: response.url,
			requestedUrl: url.href,
			format,
			mime,
			bytes: body.byteLength,
		};
		let output: string;
		if (isImage) {
			output = `Fetched image from ${response.url} (${mime})`;
		} else {
			let raw: string;
			try {
				raw = new TextDecoder("utf-8", { fatal: !mime }).decode(body);
			} catch {
				throw new Error(
					"Response has no content type and is not valid UTF-8 text; binary downloads are unsupported.",
				);
			}
			if (raw.includes("\0")) throw new Error("Response contains binary data; webfetch supports text and images.");
			output = formatFetchedText(raw, format, mime, response.url);
		}
		requestSignal.throwIfAborted();
		await builder.append(output);
		requestSignal.throwIfAborted();
		const bounded = await builder.finish();
		const content: WebFetchContent[] = [{ type: "text", text: bounded.content }];
		// Non-text image content is bounded by the source-byte limit.
		if (isImage) content.push({ type: "image", data: Buffer.from(body).toString("base64"), mimeType: mime });
		return {
			content,
			details: { ...details, overflow: bounded.overflow },
		};
	} catch (error) {
		await builder.abort();
		if (timeoutSignal.aborted && signal?.aborted !== true) {
			throw new Error(`Web fetch timed out after ${timeout}s`);
		}
		throw error;
	}
}

export function createWebFetchTool(rowState: ToolRowStateStore, temporaryOutput: TemporaryOutputStore) {
	return defineTool<typeof webFetchParams, WebFetchDetails | undefined>({
		name: "webfetch",
		label: "Web Fetch",
		annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
		description:
			"Fetch a known HTTP(S) URL as Markdown, text, or HTML. Use webfetch when you already have a URL; use websearch for broad discovery. Supports inline images and limits response bodies to 5 MB. Markdown links resolve against the final page URL. Large text results include a session temporary-file path. PDFs and other binary downloads are unsupported.",
		parameters: webFetchParams,
		async execute(_toolCallId, params, signal, onUpdate) {
			return executeWebFetch(params, signal, onUpdate, temporaryOutput);
		},
		renderCall(args, theme, context) {
			rowState.watch(context.toolCallId, context.invalidate);
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const title = formatToolRowTitle(rowState, context.toolCallId, "webfetch", theme);
			text.setText(
				`${title} ${theme.fg("accent", renderCallSummary(args) || "…")} ${theme.fg("muted", `(${args.format ?? "markdown"})`)}`,
			);
			return text;
		},
		renderResult(result, options, theme, context) {
			return renderWebToolResult(result, options, theme, context);
		},
	});
}
