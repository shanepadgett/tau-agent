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
interface WebFetchDetails {
	url: string;
	format: "markdown" | "text" | "html";
	mime: string;
	bytes: number;
	truncation?: TruncationResult;
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

export function createWebFetchTool(rowState: ToolRowStateStore) {
	return defineTool<typeof webFetchParams, WebFetchDetails | undefined>({
		name: "webfetch",
		label: "Web Fetch",
		description:
			"Fetch a known HTTP(S) URL as Markdown, text, or HTML. Supports inline images, limits response bodies to 5 MB, and truncates text to 2,000 lines or 50 KB.",
		promptSnippet: "Fetch a specific URL and extract readable content",
		promptGuidelines: [
			"Use webfetch when you already have a URL and need its content.",
			"Use websearch for broad discovery and codesearch for implementation-oriented lookups.",
			"Use a separate research workflow instead of webfetch when several searches, fetches, and synthesis are needed.",
		],
		parameters: webFetchParams,
		async execute(_toolCallId, params, signal, onUpdate) {
			let url: URL;
			try {
				url = new URL(params.url);
			} catch {
				throw new Error(`Invalid URL: ${params.url}`);
			}
			if (url.protocol !== "http:" && url.protocol !== "https:") {
				throw new Error("URL must use http:// or https://");
			}

			const format = params.format ?? "markdown";
			const timeout = normalizeTimeout(params.timeout, 30);
			await onUpdate?.({ content: [{ type: "text", text: "Fetching page..." }], details: undefined });
			const timeoutSignal = AbortSignal.timeout(timeout * 1000);
			const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

			try {
				const accept =
					format === "markdown"
						? "text/markdown;q=1.0, text/plain;q=0.8, text/html;q=0.7, */*;q=0.1"
						: format === "text"
							? "text/plain;q=1.0, text/markdown;q=0.9, text/html;q=0.8, */*;q=0.1"
							: "text/html;q=1.0, application/xhtml+xml;q=0.9, */*;q=0.1";
				const headers = {
					"User-Agent":
						"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
					Accept: accept,
					"Accept-Language": "en-US,en;q=0.9",
				};
				const first = (await fetch(url.toString(), {
					method: "GET",
					headers,
					signal: requestSignal,
				})) as FetchResponse;
				let response = first;
				if (first.status === 403 && first.headers.get("cf-mitigated")?.toLowerCase() === "challenge") {
					await first.body?.cancel().catch(() => undefined);
					response = (await fetch(url.toString(), {
						method: "GET",
						headers: { ...headers, "User-Agent": "pi" },
						signal: requestSignal,
					})) as FetchResponse;
				}
				if (!response.ok) throw new Error(`Request failed with status ${response.status}`);

				const declaredLength = response.headers.get("content-length");
				if (declaredLength !== null) {
					const bytes = Number.parseInt(declaredLength, 10);
					if (Number.isFinite(bytes) && bytes > MAX_RESPONSE_BYTES) {
						await response.body?.cancel().catch(() => undefined);
						throw new Error("Response too large (limit is 5MB)");
					}
				}

				const body = await readResponseBody(response);
				const mime = (response.headers.get("content-type")?.split(";", 1)[0] ?? "").trim().toLowerCase();
				const details = { url: url.toString(), format, mime, bytes: body.byteLength } satisfies WebFetchDetails;
				if (mime.startsWith("image/") && mime !== "image/svg+xml") {
					return {
						content: [
							{ type: "text", text: `Fetched image from ${url.toString()} (${mime})` },
							{ type: "image", data: Buffer.from(body).toString("base64"), mimeType: mime },
						],
						details,
					};
				}

				const raw = new TextDecoder().decode(body);
				const isHtml = mime === "text/html" || mime === "application/xhtml+xml";
				const output =
					format === "html" ? raw : isHtml ? (format === "text" ? htmlToText(raw) : htmlToMarkdown(raw)) : raw;
				const truncated = truncateToolOutput(output);
				return {
					content: [{ type: "text", text: truncated.text }],
					details: {
						...details,
						...(truncated.truncation ? { truncation: truncated.truncation } : {}),
					},
				};
			} catch (error) {
				if (timeoutSignal.aborted && signal?.aborted !== true) {
					throw new Error(`Web fetch timed out after ${timeout}s`);
				}
				throw error;
			}
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
