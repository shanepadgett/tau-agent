import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool, type TruncationResult } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import { formatToolRowTitle, type ToolRowStateStore } from "../../shared/tool-row-state.js";
import { htmlToMarkdown, htmlToText } from "./html.ts";
import { normalizeTimeout } from "./limits.ts";
import { renderWebToolResult, truncateCallSummary, truncateToolOutput } from "./tool-output.ts";

const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
interface FetchResponse {
	ok: boolean;
	status: number;
	headers: { get(name: string): string | null };
	body: ReadableStream<Uint8Array> | null;
}

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
	format: WebFetchFormat;
	mime: string;
	bytes: number;
	truncation?: TruncationResult;
}

type WebFetchContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

interface WebFetchResult {
	content: WebFetchContent[];
	details: WebFetchDetails;
}

async function readResponseBody(response: FetchResponse): Promise<Uint8Array> {
	if (!response.body) return new Uint8Array();
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	try {
		while (true) {
			const next = await reader.read();
			if (next.done) break;
			bytes += next.value.byteLength;
			if (bytes > MAX_RESPONSE_BYTES) {
				await reader.cancel().catch(() => undefined);
				throw new Error("Response too large (limit is 5MB)");
			}
			chunks.push(next.value);
		}
	} finally {
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
): Promise<FetchResponse> {
	const first = (await fetch(url, { method: "GET", headers, signal })) as FetchResponse;
	if (first.status !== 403 || first.headers.get("cf-mitigated")?.toLowerCase() !== "challenge") return first;
	await first.body?.cancel().catch(() => undefined);
	return (await fetch(url, {
		method: "GET",
		headers: { ...headers, "User-Agent": "pi" },
		signal,
	})) as FetchResponse;
}

async function assertDeclaredBodySizeOk(response: FetchResponse): Promise<void> {
	const declaredLength = response.headers.get("content-length");
	if (declaredLength === null) return;
	const bytes = Number.parseInt(declaredLength, 10);
	if (!Number.isFinite(bytes) || bytes <= MAX_RESPONSE_BYTES) return;
	await response.body?.cancel().catch(() => undefined);
	throw new Error("Response too large (limit is 5MB)");
}

function formatFetchedText(raw: string, format: WebFetchFormat, mime: string): string {
	if (format === "html") return raw;
	const isHtml = mime === "text/html" || mime === "application/xhtml+xml";
	if (!isHtml) return raw;
	return format === "text" ? htmlToText(raw) : htmlToMarkdown(raw);
}

function buildWebFetchResult(url: string, format: WebFetchFormat, mime: string, body: Uint8Array): WebFetchResult {
	const details = { url, format, mime, bytes: body.byteLength } satisfies WebFetchDetails;
	if (mime.startsWith("image/") && mime !== "image/svg+xml") {
		return {
			content: [
				{ type: "text", text: `Fetched image from ${url} (${mime})` },
				{ type: "image", data: Buffer.from(body).toString("base64"), mimeType: mime },
			],
			details,
		};
	}
	const truncated = truncateToolOutput(formatFetchedText(new TextDecoder().decode(body), format, mime));
	return {
		content: [{ type: "text", text: truncated.text }],
		details: {
			...details,
			...(truncated.truncation ? { truncation: truncated.truncation } : {}),
		},
	};
}

async function executeWebFetch(
	params: WebFetchParams,
	signal: AbortSignal | undefined,
	onUpdate: ((update: { content: WebFetchContent[]; details: undefined }) => void | Promise<void>) | undefined,
): Promise<WebFetchResult> {
	const url = parseFetchUrl(params.url);
	const format = params.format ?? "markdown";
	const timeout = normalizeTimeout(params.timeout, 30);
	await onUpdate?.({ content: [{ type: "text", text: "Fetching page..." }], details: undefined });
	const timeoutSignal = AbortSignal.timeout(timeout * 1000);
	const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

	try {
		const headers = {
			"User-Agent":
				"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
			Accept: acceptHeaderForFormat(format),
			"Accept-Language": "en-US,en;q=0.9",
		};
		const response = await fetchWithChallengeRetry(url.toString(), headers, requestSignal);
		if (!response.ok) throw new Error(`Request failed with status ${response.status}`);
		await assertDeclaredBodySizeOk(response);
		const body = await readResponseBody(response);
		const mime = (response.headers.get("content-type")?.split(";", 1)[0] ?? "").trim().toLowerCase();
		return buildWebFetchResult(url.toString(), format, mime, body);
	} catch (error) {
		if (timeoutSignal.aborted && signal?.aborted !== true) {
			throw new Error(`Web fetch timed out after ${timeout}s`);
		}
		throw error;
	}
}

export function createWebFetchTool(rowState: ToolRowStateStore) {
	return defineTool<typeof webFetchParams, WebFetchDetails | undefined>({
		name: "webfetch",
		label: "Web Fetch",
		description:
			"Fetch a known HTTP(S) URL as Markdown, text, or HTML. Use webfetch when you already have a URL; use websearch for broad discovery and codesearch for implementation-oriented lookups. Use a separate research workflow when several searches, fetches, and synthesis are needed. Supports inline images, limits response bodies to 5 MB, and truncates text to 2,000 lines or 50 KB.",
		parameters: webFetchParams,
		async execute(_toolCallId, params, signal, onUpdate) {
			return executeWebFetch(params, signal, onUpdate);
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
