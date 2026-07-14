import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool, type TruncationResult } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import { formatToolRowTitle, type ToolRowStateStore } from "../../shared/tool-row-state.js";
import { callExa } from "./exa.ts";
import { clampInteger, normalizeTimeout } from "./limits.ts";
import { renderWebToolResult, truncateCallSummary, truncateToolOutput } from "./tool-output.ts";

const webSearchParams = Type.Object(
	{
		query: Type.String({ description: "Web search query" }),
		numResults: Type.Optional(Type.Number({ description: "Number of results (default: 8, max: 12)" })),
		livecrawl: Type.Optional(
			StringEnum(["fallback", "preferred"] as const, { description: "Live-crawl mode (default: fallback)" }),
		),
		type: Type.Optional(StringEnum(["auto", "fast"] as const, { description: "Search type (default: auto)" })),
		contextMaxCharacters: Type.Optional(Type.Number({ description: "Context character budget (500-30000)" })),
		timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (default: 25, max: 600)" })),
	},
	{ additionalProperties: false },
);

type WebSearchParams = Static<typeof webSearchParams>;
interface WebSearchDetails {
	query: string;
	numResults: number;
	livecrawl: "fallback" | "preferred";
	type: "auto" | "fast";
	contextMaxCharacters?: number;
	truncation?: TruncationResult;
}

export function createWebSearchTool(rowState: ToolRowStateStore) {
	return defineTool<typeof webSearchParams, WebSearchDetails | undefined>({
		name: "websearch",
		label: "Web Search",
		description:
			"Search the public web through Exa for current information and relevant pages. Use websearch for broad discovery, then webfetch for a known URL; use codesearch for implementation-oriented code and documentation context. Use a separate research workflow when several searches, fetches, and synthesis are needed. Output is truncated to 2,000 lines or 50 KB.",
		parameters: webSearchParams,
		async execute(_toolCallId, params, signal, onUpdate) {
			const timeout = normalizeTimeout(params.timeout, 25);
			const numResults = clampInteger(params.numResults, 8, 1, 12);
			const livecrawl = params.livecrawl ?? "fallback";
			const type = params.type ?? "auto";
			const contextMaxCharacters =
				params.contextMaxCharacters === undefined
					? undefined
					: clampInteger(params.contextMaxCharacters, 500, 500, 30_000);
			await onUpdate?.({ content: [{ type: "text", text: "Searching web..." }], details: undefined });
			try {
				const output =
					(await callExa(
						{
							toolName: "web_search_exa",
							arguments: { query: params.query, type, numResults, livecrawl, contextMaxCharacters },
						},
						signal,
						timeout,
					)) ?? "No search results found. Try a more specific query.";
				const truncated = truncateToolOutput(output);
				return {
					content: [{ type: "text", text: truncated.text }],
					details: {
						query: params.query,
						numResults,
						livecrawl,
						type,
						...(contextMaxCharacters === undefined ? {} : { contextMaxCharacters }),
						...(truncated.truncation ? { truncation: truncated.truncation } : {}),
					},
				};
			} catch (error) {
				if (error instanceof Error && error.name === "TimeoutError") {
					throw new Error(`Web search timed out after ${timeout}s`);
				}
				throw error;
			}
		},
		renderCall(args: WebSearchParams, theme, context) {
			rowState.watch(context.toolCallId, context.invalidate);
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const title = formatToolRowTitle(rowState, context.toolCallId, "websearch", theme);
			const summary = truncateCallSummary((args.query ?? "").trim()) || "…";
			text.setText(
				`${title} ${theme.fg("accent", summary)} ${theme.fg("muted", `(${args.type ?? "auto"}, n=${clampInteger(args.numResults, 8, 1, 12)})`)}`,
			);
			return text;
		},
		renderResult(result, options, theme, context) {
			return renderWebToolResult(result, options, theme, context);
		},
	});
}
